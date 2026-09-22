import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Anomaly, Output, Proposition } from '../contracts/output.js';
import { analyzePdf } from '../agents/pdf_forensics.js';
import { calculateAssets } from './assets.js';
import type { AssetRow } from './assets.js';
import { detectInternalTransfers, detectTruncations, matchBankToLedger, verifyStatementChecksum, type StatementChecksum, type SuspensItem, type TruncationFinding } from './bank_engine.js';
import { loadClosingDataset, nextMonthEnd, type ClosingDataset, type Row } from './dataset.js';
import { checkLedgerIntegrity } from './integrity.js';
import { cents, mad } from './money.js';
import {
  draftCashWithdrawalReclassifications,
  draftComplementForUnbalancedEntry,
  draftInternalTransferReclassifications,
  draftReturnedChequePostings,
  draftTruncationCorrection,
  draftUnrecordedFeePostings,
  findAccountByLabel,
  findDuplicateInvoiceReversals,
  inTransitItems,
  type PostingDraft,
} from './postings.js';
import {
  draftAccruedInterest,
  draftAssociateAdvanceExpense,
  draftCashContribution,
  draftCashThresholdNonDeductible,
  draftCcaDeferral,
  draftDepreciationEntries,
  draftEmbeddedFeeVatCorrection,
  draftFaeAccrual,
  draftFnpAccrual,
  draftFnpReversal,
  draftInventoryVariance,
  draftLatentForexProvision,
  draftLoanInstallmentSplit,
  draftMissingSalesInvoice,
  draftNonDeductibleVatReclass,
  draftPayrollEntry,
  draftPcaDeferral,
  draftPersonalUseSplit,
  draftRealizedForexLosses,
  draftRecurringCcaRecognition,
  draftRentWithholding,
  draftSettlementGapFees,
  draftSocialLatePenalty,
  draftSuspenseResolution,
  draftVatSettlement,
  findLateSupplierDocument,
  findScenarioAnswer,
  findScenarioAnswerByTokenOverlap,
  parseInvoiceTotals,
} from './postings_run3.js';
import { calculateVat, calculateVatEncaissement, vatAccountTypes, type VatResult } from './vat_engine.js';
import {
  detectAnalyticVariances,
  detectDoubtfulReceivables,
  detectLegitimateSuspens,
  detectMultiInvoiceLettrage,
  detectOverdueSupplierInvoices,
  detectUnpaidWithholdingTax,
  detectVatDeclarationGap,
  type AnomalyDraft,
} from './anomalies_run2.js';

const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const net = (row: Row): number => numberValue(row.debit) - numberValue(row.credit);

function accountBalance(dataset: ClosingDataset, account: string): number {
  const opening = dataset.openingBalance.find((row) => row.compte === account);
  const movements = dataset.ledger.filter((row) => row.compte === account).reduce((total, row) => total + net(row), 0);
  return numberValue(opening?.debit) - numberValue(opening?.credit) + movements;
}

function statementBalance(header: Record<string, unknown>): number {
  const value = header.solde_final_imprime ?? header.solde_final ?? header.balance_finale;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('Solde final bancaire absent ou invalide');
  return parsed;
}

function anomaly(id: string, title: string, description: string, evidence: string[], gravite: string = 'moyenne', actionAttendue?: string, question?: string): Anomaly {
  return { id, titre: title, description, gravite, preuves: evidence, question: question ?? null, ...(actionAttendue ? { action_attendue: actionAttendue } : {}) };
}

function tiersLabel(dataset: ClosingDataset, code: string | undefined): string | undefined {
  if (!code) return undefined;
  return dataset.tiers.find((row) => row.code === code)?.nom;
}

function missingEvidenceAnomalies(dataset: ClosingDataset, anomalies: Anomaly[], opts: { lockedFin: string; excludedEcritureIds: Set<string> }): void {
  const nameTokens = companyNameTokens(String(((dataset.societe as { raison_sociale?: unknown }).raison_sociale) ?? ''));
  const natureByCode = new Map(dataset.chart.map((row) => [String(row.code ?? ''), String(row.nature ?? '')]));
  const missing = new Map<string, Row>();
  for (const row of dataset.ledger) {
    // Une charge sans justificatif ET sans référence bancaire de rapprochement est une pièce
    // manquante réelle. Les lignes bancaires (ref_banque renseignée) et les écritures déjà
    // traitées ailleurs (période verrouillée, doublon) ne sont pas reprises ici.
    if (row.justificatif || row.ref_banque || !row.piece) continue;
    if (row.date_ecriture && row.date_ecriture <= opts.lockedFin) continue;
    if (row.ecriture_id && opts.excludedEcritureIds.has(row.ecriture_id)) continue;
    if (natureByCode.get(row.compte ?? '') !== 'CHARGE') continue;
    missing.set(row.piece, row);
  }
  for (const [piece, row] of missing) {
    const tierCode = row.tiers || dataset.ledger.find((candidate) => candidate.piece === piece && candidate.tiers)?.tiers;
    const tier = tiersLabel(dataset, tierCode);
    const context = [redactCompanyName(row.libelle, nameTokens), tier].filter(Boolean).join(' — ');
    anomalies.push(anomaly(
      `ANO-${String(anomalies.length + 1).padStart(3, '0')}`,
      'Écriture sans justificatif référencé',
      `La pièce ${piece}${context ? ` (${context})` : ''} ne comporte pas de justificatif formel dans l'index des pièces ; aucune écriture complémentaire n'est générée.`,
      [`GL:${piece}`, `GL-LIGNE:${row.ecriture_id || piece}`],
      'haute',
      'question_client',
      tier ? `Merci de transmettre la facture ou le justificatif formel pour la pièce ${piece} (${tier}, ${row.date_ecriture ?? ''}) : aucun document n'y est associé dans l'index.` : undefined,
    ));
  }
}

function policyMaximumQuestions(dataset: ClosingDataset): number {
  const questions = dataset.policy.garde_fous as Record<string, unknown> | undefined;
  const client = questions?.questions_client as Record<string, unknown> | undefined;
  const configured = Number(client?.max_par_cloture);
  return Number.isInteger(configured) && configured >= 0 ? configured : 0;
}

function questionsFor(anomalies: Anomaly[], maximum: number): Output['questions'] {
  return anomalies
    .filter((item): item is Anomaly & { question: string } => typeof item.question === 'string' && item.question.length > 0)
    .slice(0, Math.max(0, maximum))
    .map((item) => ({
      id: item.id,
      sujet: item.titre,
      texte: item.question,
      preuve: item.preuves[0],
    }));
}

function companyNameTokens(raisonSociale: string): string[] {
  return raisonSociale
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 5);
}

function redactCompanyName(libelle: string | undefined, tokens: string[]): string | undefined {
  if (!libelle || tokens.length === 0) return libelle;
  const pattern = new RegExp(`(?:${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  return libelle.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
}

export class ClosingEngine {
  constructor(private readonly datasetDir: string, private readonly period: string) {}

  async run(): Promise<Output> {
    const dataset = await loadClosingDataset(this.datasetDir, this.period);
    const anomalies: Anomaly[] = [];
    const propositions: Proposition[] = [];
    let propositionCounter = 0;
    const allocatePropositionIds = (count: number): string[] => {
      propositionCounter += 1;
      const base = `P-${String(propositionCounter).padStart(2, '0')}`;
      if (count <= 1) return [base];
      return Array.from({ length: count }, (_, index) => `${base}${String.fromCharCode(65 + index)}`);
    };
    const push = (titre: string, description: string, preuves: string[], gravite = 'moyenne', actionAttendue?: string, question?: string): string => {
      const id = `ANO-${String(anomalies.length + 1).padStart(3, '0')}`;
      anomalies.push(anomaly(id, titre, description, preuves, gravite, actionAttendue, question));
      return id;
    };
    const pushDraft = (draft: AnomalyDraft): string => push(draft.titre, draft.description, draft.preuves, draft.gravite, draft.actionAttendue, draft.question);
    const addProposition = (anomalieId: string, draft: PostingDraft & { contre_passation_le?: string; question_prealable?: string }, id?: string): void => {
      propositions.push({
        id: id ?? allocatePropositionIds(1)[0],
        anomalie: anomalieId,
        type: draft.type,
        date: draft.date,
        journal: draft.journal,
        libelle: draft.libelle,
        certitude: draft.certitude,
        statut: 'proposee',
        preuves: draft.preuves,
        lignes: draft.lignes,
        ...(draft.contre_passation_le ? { contre_passation_le: draft.contre_passation_le } : {}),
        ...(draft.question_prealable ? { question_prealable: draft.question_prealable } : {}),
      });
    };

    const lockedFin = String(((dataset.societe.derniere_periode_verrouillee as { fin?: unknown } | null | undefined)?.fin) ?? '');
    for (const issue of checkLedgerIntegrity(dataset.ledger, dataset.chart, lockedFin)) {
      const piece = issue.piece ?? issue.ecriture_id ?? 'inconnue';
      if (issue.type === 'ecriture_desequilibree') {
        const lines = dataset.ledger.filter((row) => row.ecriture_id === issue.ecriture_id);
        const entryPiece = lines[0]?.piece || piece;
        const doc = dataset.documents.find((row) => (row.statut_plateforme ?? '').toUpperCase().includes(entryPiece.toUpperCase()));
        const tier = doc?.tiers ? dataset.tiers.find((row) => row.code === doc.tiers) : undefined;
        const question = tier
          ? `Confirmez-vous que l'écriture ${issue.ecriture_id ?? piece} (pièce jointe ${doc?.fichier}, ${Math.abs(issue.ecart ?? 0)} MAD) concerne bien le fournisseur ${tier.nom} ?`
          : undefined;
        const anomalieId = push(
          'Ecriture desequilibree',
          `L’écriture ${issue.ecriture_id ?? piece} présente un écart de ${issue.ecart ?? 0} MAD ; aucune écriture corrective n’est générée.`,
          [`GL:${piece}`],
          'bloquante',
          question ? 'question_client' : undefined,
          question,
        );
        const entryDate = lines[0]?.date_ecriture ?? '';
        if (issue.ecriture_id && entryDate > lockedFin) {
          const draft = draftComplementForUnbalancedEntry(issue.ecriture_id, dataset.ledger, dataset.documents, dataset.tiers);
          if (draft) addProposition(anomalieId, draft);
        }
      } else if (issue.type === 'periode_verrouillee') {
        push(
          'Periode verrouillee',
          `L’écriture ${issue.ecriture_id ?? piece} est datée dans une période verrouillée ; aucune écriture corrective n’est générée.`,
          [`GL:${piece}`],
          'bloquante',
          'escalade_expert_comptable',
        );
      } else if (issue.type === 'compte_collectif') {
        push(
          'Ecriture sur compte collectif',
          `L’écriture ${issue.ecriture_id ?? piece} mouvemente le compte collectif ${issue.compte ?? 'inconnu'} ; aucune écriture corrective n’est générée.`,
          [`GL:${piece}`],
          'haute',
        );
      }
    }

    const accountByKey = new Map(dataset.banks.map((bank) => [bank.key, String(bank.header.compte_gl ?? '')]));
    const checksums = new Map<string, StatementChecksum>();
    const truncationsByBank = new Map<string, TruncationFinding[]>();
    const suspensByBank = new Map<string, SuspensItem[]>();
    for (const bank of dataset.banks) {
      const checksum = verifyStatementChecksum(bank.header, bank.rows);
      checksums.set(bank.key, checksum);
      truncationsByBank.set(bank.key, detectTruncations({ key: bank.key, rows: bank.rows }, checksum, dataset.ledger, dataset.chart));
      suspensByBank.set(bank.key, matchBankToLedger({ key: bank.key, rows: bank.rows }, dataset.ledger, accountByKey.get(bank.key) ?? '').suspens);
    }

    for (const bank of dataset.banks) {
      const checksum = checksums.get(bank.key) ?? verifyStatementChecksum(bank.header, bank.rows);
      if (!checksum.coherent) {
        push(
          'Totaux du relevé incohérents avec les lignes extraites',
          `Les totaux imprimés du relevé ${bank.key} ne correspondent pas à la somme des lignes extraites ; les montants extraits doivent être confirmés.`,
          [`BQ:${bank.key}`],
          'haute',
        );
      }
      for (const finding of truncationsByBank.get(bank.key) ?? []) {
        const anomalieId = push(
          'Extraction tronquee',
          `La ligne ${finding.id_ligne} a été extraite à ${finding.montant_extrait} MAD au lieu de ${finding.montant_corrige} MAD (pièce ${finding.piece}) ; le montant corrigé est proposé.`,
          [`BQ:${bank.key}:${finding.id_ligne}`],
          'haute',
        );
        const draft = draftTruncationCorrection(finding, dataset.banks, dataset.ledger);
        if (draft) addProposition(anomalieId, draft);
      }
    }

    const banksLike = dataset.banks.map((bank) => ({ key: bank.key, name: bank.name, rows: bank.rows, header: bank.header }));
    const transfers = detectInternalTransfers(dataset.banks.map((bank) => ({ key: bank.key, rows: bank.rows })));
    for (const transfer of transfers) {
      const anomalieId = push(
        'Mouvement de virement interne a comptabiliser via virements de fonds',
        `Le mouvement ${transfer.source.id_ligne} (${transfer.source.key}) vers ${transfer.cible.id_ligne} (${transfer.cible.key}) de ${transfer.montant} MAD doit transiter par les virements de fonds.`,
        [`BQ:${transfer.source.key}:${transfer.source.id_ligne}`, `BQ:${transfer.cible.key}:${transfer.cible.id_ligne}`],
        'haute',
      );
      for (const reclassification of draftInternalTransferReclassifications({ transfers: [transfer], banks: banksLike, ledger: dataset.ledger, chart: dataset.chart })) {
        addProposition(anomalieId, reclassification.draft);
      }
    }

    const duplicateReversals = findDuplicateInvoiceReversals(dataset.ledger, dataset.periodEnd);
    missingEvidenceAnomalies(dataset, anomalies, {
      lockedFin,
      excludedEcritureIds: new Set(duplicateReversals.map((reversal) => reversal.duplicateEcritureId)),
    });

    for (const draft of detectMultiInvoiceLettrage(dataset.openItems, dataset.tiers)) pushDraft(draft);
    for (const draft of detectOverdueSupplierInvoices({ openItems: dataset.openItems, chart: dataset.chart, tiers: dataset.tiers, fiscal: dataset.fiscal, periodEnd: dataset.periodEnd })) pushDraft(draft);
    for (const draft of detectDoubtfulReceivables({ openItems: dataset.openItems, tiers: dataset.tiers, suspensByBank: Object.fromEntries(suspensByBank), periodEnd: dataset.periodEnd })) pushDraft(draft);

    for (const reversal of duplicateReversals) {
      const anomalieId = push(
        'Facture fournisseur en doublon',
        `L’écriture ${reversal.duplicateEcritureId} duplique l’écriture ${reversal.keeperEcritureId} déjà justifiée ; une contre-passation est proposée.`,
        [`GL:${reversal.duplicateEcritureId}`, `GL:${reversal.keeperEcritureId}`],
        'haute',
      );
      addProposition(anomalieId, reversal.draft);
    }

    const feePostings = draftUnrecordedFeePostings({ banks: banksLike, ledger: dataset.ledger, chart: dataset.chart, fiscal: dataset.fiscal });
    if (feePostings.length > 0) {
      const anomalieId = push(
        'Frais bancaires débités non comptabilisés',
        `Les frais suivants apparaissent sur les relevés bancaires sans écriture correspondante dans le grand livre : ${feePostings.map((item) => `${item.bankKey}:${item.idLigne}`).join(', ')}.`,
        feePostings.map((item) => `BQ:${item.bankKey}:${item.idLigne}`),
        'moyenne',
      );
      const ids = allocatePropositionIds(feePostings.length);
      feePostings.forEach((item, index) => addProposition(anomalieId, item.draft, ids[index]));
    }

    for (const cheque of draftReturnedChequePostings({ suspensByBank: Object.fromEntries(suspensByBank), banks: banksLike, tiers: dataset.tiers })) {
      const anomalieId = push(
        'Chèque client impayé',
        `Le règlement ${cheque.bankKey}:${cheque.idLigne} a été rejeté par la banque ; une extourne du client concerné est proposée.`,
        [`BQ:${cheque.bankKey}:${cheque.idLigne}`],
        'haute',
      );
      addProposition(anomalieId, cheque.draft);
    }

    for (const withdrawal of draftCashWithdrawalReclassifications({ banks: banksLike, ledger: dataset.ledger, chart: dataset.chart, societe: dataset.societe })) {
      const anomalieId = push(
        'Retrait DAB comptabilisé en charge',
        `Le retrait ${withdrawal.bankKey}:${withdrawal.idLigne} alimente la caisse mais a été saisi sur un compte de charge ; une reclassification est proposée.`,
        [`BQ:${withdrawal.bankKey}:${withdrawal.idLigne}`],
        'moyenne',
      );
      addProposition(anomalieId, withdrawal.draft);
    }

    // ── RUN3 — accruals, actifs, paie, change, fiscal (P-05, P-09 à P-36) ──────────────────
    const periodStart = `${dataset.period}-01`;
    const nextMonthStart = ((): string => {
      const [year, month] = dataset.periodEnd.split('-').map(Number);
      return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    })();
    const caisseCompte = String(((dataset.societe.caisse as { compte?: unknown } | undefined)?.compte) ?? '');
    const datasetRoot = decodeURIComponent(this.datasetDir);
    const readAttachment = async (relPath: string): Promise<string | undefined> => {
      try {
        const buffer = await readFile(join(datasetRoot, relPath));
        return analyzePdf(buffer).allText;
      } catch {
        return undefined;
      }
    };

    const feeVatDraft = draftEmbeddedFeeVatCorrection({ ledger: dataset.ledger, chart: dataset.chart, fiscal: dataset.fiscal, periodEnd: dataset.periodEnd });
    if (feeVatDraft) {
      const anomalieId = push(
        'Frais bancaires comptabilisés TTC sans TVA récupérable extraite',
        'Des frais bancaires ont été saisis TTC dans le journal sans extraction de la TVA récupérable correspondante ; une correction est proposée.',
        feeVatDraft.preuves,
        'faible',
      );
      addProposition(anomalieId, feeVatDraft);
    }

    const suspenseResolution = draftSuspenseResolution({ ledger: dataset.ledger, chart: dataset.chart, scenario: dataset.clientScenario, periodEnd: dataset.periodEnd });
    if (suspenseResolution) {
      const montantLigne = suspenseResolution.draft.lignes[0]?.debit ?? 0;
      const anomalieId = push(
        "Virement reçu non identifié en compte d'attente",
        `Un virement de ${montantLigne} MAD reste non identifié en compte transitoire au ${suspenseResolution.draft.date} ; la réponse du client permet de le régulariser.`,
        suspenseResolution.draft.preuves,
        'moyenne',
        'question_client',
        `Pouvez-vous confirmer l'origine du virement de ${montantLigne} MAD reçu le ${suspenseResolution.draft.date} ?`,
      );
      addProposition(anomalieId, suspenseResolution.draft);
    }

    const cashContribution = await draftCashContribution({
      datasetDir: this.datasetDir,
      chart: dataset.chart,
      scenario: dataset.clientScenario,
      caisseCompte,
      triggerKeywords: ['caisse', 'especes', 'espèces'],
      readAttachment,
    });
    const caisseSoldeFinal = caisseCompte ? accountBalance(dataset, caisseCompte) : 0;
    if (caisseSoldeFinal < 0) {
      if (cashContribution) {
        const montantLigne = cashContribution.draft.lignes[0]?.debit ?? 0;
        const anomalieId = push(
          'Caisse négative au 31/08',
          `Le solde de caisse calculé est négatif (${caisseSoldeFinal} MAD) ; la réponse du client confirme un apport en espèces de ${montantLigne} MAD non enregistré.`,
          cashContribution.draft.preuves,
          'haute',
          'question_client',
          `Le solde de caisse calculé est négatif (${caisseSoldeFinal} MAD) : confirmez-vous l'apport en espèces que vous mentionnez ?`,
        );
        addProposition(anomalieId, cashContribution.draft);
      } else {
        push(
          'Caisse négative au 31/08',
          `Le solde de caisse calculé (${caisseSoldeFinal} MAD) est négatif ; aucune écriture corrective n'est générée sans confirmation du client.`,
          [`GL:${caisseCompte}`],
          'haute',
          'question_client',
          `Le solde de caisse calculé au 31/08 est négatif (${caisseSoldeFinal} MAD) : pouvez-vous expliquer cet écart ?`,
        );
      }
    }

    for (const draft of draftCashThresholdNonDeductible({ ledger: dataset.ledger, chart: dataset.chart, fiscal: dataset.fiscal, caisseCompte, periodEnd: dataset.periodEnd })) {
      const anomalieId = push(
        'TVA non déductible — règlement en espèces au-delà du plafond',
        `Un règlement en espèces dépasse le plafond de déductibilité TVA par jour et par fournisseur ; la fraction excédentaire est reclassée en charge non déductible.`,
        draft.preuves,
        'haute',
      );
      addProposition(anomalieId, draft);
    }

    for (const draft of draftSettlementGapFees({ ledger: dataset.ledger, chart: dataset.chart, policy: dataset.policy, fiscal: dataset.fiscal })) {
      const anomalieId = push(
        'Écart de règlement client traité en frais bancaires',
        `Un écart de règlement inférieur ou égal au seuil défini par la politique du cabinet est reclassé en frais bancaires.`,
        draft.preuves,
        'faible',
      );
      addProposition(anomalieId, draft);
    }

    for (const draft of draftRealizedForexLosses({ ledger: dataset.ledger, chart: dataset.chart, banks: banksLike })) {
      const anomalieId = push(
        'Perte de change réalisée non constatée',
        `Un règlement en devise a été effectué à un cours différent du cours historique de facturation ; la perte de change réalisée est constatée.`,
        draft.preuves,
        'moyenne',
      );
      addProposition(anomalieId, draft);
    }

    const missingSalesInvoice = draftMissingSalesInvoice({ documents: dataset.documents, ledger: dataset.ledger, tiers: dataset.tiers, chart: dataset.chart });
    if (missingSalesInvoice) {
      const anomalieId = push(
        'Facture de vente émise mais absente du grand livre',
        `Une facture de vente référencée dans l'index des justificatifs n'apparaît pas dans le grand livre de la période : rupture de séquence à corriger.`,
        missingSalesInvoice.preuves,
        'haute',
      );
      addProposition(anomalieId, missingSalesInvoice);
    }

    const fnpReversal = draftFnpReversal({ ledger: dataset.ledger, chart: dataset.chart, openingBalance: dataset.openingBalance, policy: dataset.policy, periodStart, lockedFin });
    if (fnpReversal) {
      const anomalieId = push(
        'FNP antérieure non contre-passée',
        `Une facture non parvenue de la période précédente n'a pas été contre-passée alors que la facture réelle a été saisie ce mois-ci : la charge aurait été comptée deux fois.`,
        fnpReversal.draft.preuves,
        'haute',
      );
      addProposition(anomalieId, fnpReversal.draft);
    }

    // Le même fournisseur récurrent (identifié ci-dessus par sa FNP non reprise) peut avoir une
    // facture du mois courant pas encore reçue à la clôture : on recherche, par recoupement de
    // mots-clés (jamais par nom en dur), la question client qui lui correspond dans le scénario.
    const recurringSupplierTier = fnpReversal?.supplierTierCode
      ? dataset.tiers.find((row) => row.code === fnpReversal.supplierTierCode)
      : undefined;
    const q04 = recurringSupplierTier ? findScenarioAnswerByTokenOverlap(dataset.clientScenario, recurringSupplierTier.nom ?? '') : undefined;
    if (q04?.reponse && recurringSupplierTier) {
      const supplierTier = recurringSupplierTier;
      const historicalCharge = fnpReversal?.chargeAccount ? { compte: fnpReversal.chargeAccount } : undefined;
      if (supplierTier && historicalCharge?.compte) {
        let text = q04.reponse;
        for (const attachment of q04.pieces_jointes ?? []) {
          const content = await readAttachment(attachment);
          if (content) text = `${text} ${content}`;
        }
        const totals = parseInvoiceTotals(text);
        if (totals) {
          const fnpDraft = draftFnpAccrual({
            source: { ht: totals.ht, tva: totals.tva, chargeAccount: historicalCharge.compte, proof: `SIM:${q04.id}` },
            policy: dataset.policy,
            periodEnd: dataset.periodEnd,
            nextMonthStart,
            libelle: `FNP ${supplierTier.nom} — consommation du mois`,
          });
          if (fnpDraft) {
            const anomalieId = push(
              `Facture ${supplierTier.nom} du mois non reçue au 31/08`,
              `La facture du mois n'était pas reçue à la clôture ; une charge à payer est constituée sur la base du document transmis par le client.`,
              fnpDraft.preuves,
              'moyenne',
              'question_client',
              `Merci de transmettre la facture ${supplierTier.nom} du mois : elle n'apparaît pas dans le grand livre au 31/08.`,
            );
            addProposition(anomalieId, fnpDraft);
          }
        }
      }
    }

    const lateDocument = findLateSupplierDocument({
      documents: dataset.documents,
      tiers: dataset.tiers,
      chart: dataset.chart,
      ledger: dataset.ledger,
      periodEnd: dataset.periodEnd,
      periodStart,
      folderHint: 'RECUS_EN_SEPTEMBRE',
    });
    if (lateDocument) {
      const lateDraft = draftFnpAccrual({ source: lateDocument, policy: dataset.policy, periodEnd: dataset.periodEnd, nextMonthStart, libelle: 'Charge à payer — pièce reçue après la clôture' });
      if (lateDraft) {
        const anomalieId = push(
          'Charge à payer — pièce reçue après la clôture',
          `Une pièce concernant la période a été reçue après la clôture ; une charge à payer est constituée sur la base du document.`,
          lateDraft.preuves,
          'moyenne',
        );
        addProposition(anomalieId, lateDraft);
      }
    }

    const faeDraft = draftFaeAccrual({ documents: dataset.documents, chart: dataset.chart, policy: dataset.policy, periodEnd: dataset.periodEnd, nextMonthStart });
    if (faeDraft) {
      const anomalieId = push(
        'Travaux réceptionnés non facturés — produit à établir',
        `Un procès-verbal de réception atteste de travaux effectués sur la période, non encore facturés : un produit à établir est constitué depuis le devis accepté.`,
        faeDraft.preuves,
        'haute',
      );
      addProposition(anomalieId, faeDraft);
    }

    const pcaDraft = draftPcaDeferral({ ledger: dataset.ledger, tiers: dataset.tiers, chart: dataset.chart, periodEnd: dataset.periodEnd });
    if (pcaDraft) {
      const anomalieId = push(
        'Produit constaté d\'avance — service rendu sur une période postérieure',
        `Un produit facturé et comptabilisé ce mois-ci correspond à une prestation dont la période de service démarre après la clôture : un produit constaté d'avance est constitué.`,
        pcaDraft.preuves,
        'haute',
      );
      addProposition(anomalieId, pcaDraft);
    }

    const ccaDraft = draftCcaDeferral({ ledger: dataset.ledger, tiers: dataset.tiers, chart: dataset.chart, periodEnd: dataset.periodEnd });
    if (ccaDraft) {
      const anomalieId = push(
        'Charge constatée d\'avance — abonnement pluriannuel passé en charge intégralement',
        `Un abonnement facturé pour plusieurs mois a été passé intégralement en charge ce mois-ci : la part relative aux mois suivants est constatée d'avance.`,
        ccaDraft.preuves,
        'haute',
      );
      addProposition(anomalieId, ccaDraft);
    }

    const recurringCca = draftRecurringCcaRecognition({ ledger: dataset.ledger, history: dataset.history, openingBalance: dataset.openingBalance, chart: dataset.chart, periodEnd: dataset.periodEnd, lockedFin });
    if (recurringCca) {
      const anomalieId = push(
        'Reprise mensuelle d\'une charge constatée d\'avance récurrente non passée',
        `Une charge récurrente strictement constante sur l'historique n'a pas été mouvementée ce mois-ci alors qu'une charge constatée d'avance ouverte doit être reprise.`,
        recurringCca.preuves,
        'moyenne',
      );
      addProposition(anomalieId, recurringCca);
    }

    const loanRefLine = dataset.ledger.find((row) => row.compte === findAccountByLabel(dataset.chart, ['emprunts', 'etablissements', 'credit'], 'PASSIF') && numberValue(row.debit) > 0);
    const loanRef = loanRefLine?.piece ?? loanRefLine?.ref_banque ?? 'emprunt';
    const accruedInterest = draftAccruedInterest({ schedule: dataset.loanSchedule, chart: dataset.chart, policy: dataset.policy, periodEnd: dataset.periodEnd, loanRef });
    if (accruedInterest) {
      const anomalieId = push(
        'Intérêts courus sur emprunt non constatés',
        `Des intérêts courus depuis la dernière échéance de l'emprunt dépassent le seuil de comptabilisation de la politique cabinet et ne sont pas constatés.`,
        accruedInterest.preuves,
        'faible',
      );
      addProposition(anomalieId, accruedInterest);
    }

    const loanSplit = draftLoanInstallmentSplit({ ledger: dataset.ledger, schedule: dataset.loanSchedule, chart: dataset.chart });
    if (loanSplit) {
      const anomalieId = push(
        'Échéance de prêt comptabilisée intégralement en capital',
        `L'échéance de prêt a été saisie en totalité sur le compte de capital restant dû ; la part d'intérêts figurant dans le tableau d'amortissement est reclassée.`,
        loanSplit.preuves,
        'moyenne',
      );
      addProposition(anomalieId, loanSplit);
    }

    const personalUseSplit = draftPersonalUseSplit({ ledger: dataset.ledger, chart: dataset.chart, policy: dataset.policy, scenario: dataset.clientScenario, triggerKeywords: ['ordinateur', 'portable', 'informatique'] });
    let syntheticAsset: AssetRow | undefined;
    if (personalUseSplit?.companyDraft) {
      const anomalieId = push(
        'Immobilisation informatique non capitalisée (dépassement du seuil)',
        `Un équipement informatique dont le montant dépasse le seuil de capitalisation de la politique cabinet a été passé en charge ; il est reclassé en immobilisation, TVA comprise.`,
        personalUseSplit.companyDraft.preuves,
        'moyenne',
        'question_client',
        `Confirmez-vous l'affectation professionnelle de l'équipement informatique de la pièce ${personalUseSplit.excludedPiece} ?`,
      );
      addProposition(anomalieId, personalUseSplit.companyDraft);
      const line = personalUseSplit.companyDraft.lignes[0];
      // Taux d'amortissement dérivé des immobilisations existantes du même compte (aucun taux
      // en dur) : le registre du poste concerné fait foi pour ce type de matériel.
      const sameAccountRate = dataset.assets.find((asset) => asset.compte === line?.compte)?.taux_pct;
      if (line && sameAccountRate !== undefined) {
        syntheticAsset = {
          id: `${personalUseSplit.excludedPiece}-IMMO`,
          date_acquisition: personalUseSplit.companyDraft.date,
          valeur_origine_ht: line.debit,
          taux_pct: sameAccountRate,
          compte: line.compte,
          compte_amortissement: findAccountByLabel(dataset.chart, ['amortissements', 'materiel', 'informatique'], 'ACTIF') ?? '',
        };
      }
    }
    if (personalUseSplit?.personalDraft) {
      const anomalieId = push(
        'Équipement à usage personnel du dirigeant payé par la société',
        `Un équipement identifié comme étant à usage personnel du dirigeant a été payé par la société ; il est reclassé en compte courant associé débiteur — alerte juridique : ce type de compte est interdit pour un associé personne physique en SARL, escalade à l'expert-comptable.`,
        personalUseSplit.personalDraft.preuves,
        'haute',
        'escalade_expert_comptable',
      );
      addProposition(anomalieId, personalUseSplit.personalDraft);
    }

    const assets = calculateAssets({
      rows: syntheticAsset ? [...dataset.assets, syntheticAsset] : dataset.assets,
      periodEnd: dataset.periodEnd,
    });
    const depreciationDraft = draftDepreciationEntries({ chart: dataset.chart, assets, periodEnd: dataset.periodEnd });
    if (depreciationDraft) {
      const anomalieId = push(
        'Dotations aux amortissements du mois non passées',
        `Les dotations aux amortissements linéaires du mois n'ont pas été comptabilisées ; elles sont calculées depuis le registre des immobilisations.`,
        depreciationDraft.preuves,
        'moyenne',
      );
      addProposition(anomalieId, depreciationDraft);
    }

    const inventoryVariance = draftInventoryVariance({
      inventory: dataset.inventory,
      ledger: dataset.ledger,
      openingBalance: dataset.openingBalance,
      chart: dataset.chart,
      scenario: dataset.clientScenario,
      triggerKeywords: ['inventaire', 'cable', 'câble'],
      periodEnd: dataset.periodEnd,
    });
    if (inventoryVariance) {
      const anomalieId = push(
        'Variation de stock non constatée',
        `L'inventaire physique du 31/08, après correction confirmée par le client, diffère du stock comptable : la variation est constatée.`,
        inventoryVariance.draft.preuves,
        'moyenne',
        'question_client',
        `L'inventaire du 31/08 comporte une quantité négative sur un article : pouvez-vous confirmer la quantité réelle en stock ?`,
      );
      addProposition(anomalieId, inventoryVariance.draft);
    }

    const latentForex = draftLatentForexProvision({ ledger: dataset.ledger, chart: dataset.chart, fxRates: dataset.fxRates, periodEnd: dataset.periodEnd });
    if (latentForex) {
      const anomalieId = push(
        'Solde en devise non réévalué au cours de clôture',
        `Un solde fournisseur/client libellé en devise n'a pas été réévalué au cours de Bank Al-Maghrib du dernier jour du mois ; la perte latente est provisionnée.`,
        latentForex.preuves,
        'moyenne',
      );
      addProposition(anomalieId, latentForex);
    }

    for (const draft of draftNonDeductibleVatReclass({ ledger: dataset.ledger, chart: dataset.chart, fiscal: dataset.fiscal, periodEnd: dataset.periodEnd })) {
      const anomalieId = push(
        'TVA récupérée à tort sur une charge non déductible',
        `De la TVA a été comptabilisée comme récupérable sur une charge visée par la liste des exclusions fiscales ; elle est reclassée en charge non déductible.`,
        draft.preuves,
        'faible',
      );
      addProposition(anomalieId, draft);
    }

    const payrollDraft = draftPayrollEntry({ payroll: dataset.payroll, chart: dataset.chart, periodEnd: dataset.periodEnd });
    if (payrollDraft) {
      const anomalieId = push(
        'Paie du mois non comptabilisée',
        `Le journal de paie du mois n'a pas été comptabilisé alors que le virement des salaires a été exécuté ; l'écriture est reconstituée depuis le journal de paie.`,
        payrollDraft.preuves,
        'haute',
      );
      addProposition(anomalieId, payrollDraft);
    }

    const socialPenalty = draftSocialLatePenalty({ ledger: dataset.ledger, chart: dataset.chart, priorDeclarations: dataset.priorDeclarations, fiscal: dataset.fiscal, periodEnd: dataset.periodEnd });
    if (socialPenalty) {
      const anomalieId = push(
        'Majoration de retard sur cotisation sociale',
        `La cotisation sociale de la période précédente a été payée après l'échéance ; une majoration de retard est constatée.`,
        socialPenalty.preuves,
        'moyenne',
      );
      addProposition(anomalieId, socialPenalty);
    }

    const rentWithholding = draftRentWithholding({ ledger: dataset.ledger, tiers: dataset.tiers, chart: dataset.chart, fiscal: dataset.fiscal });
    if (rentWithholding) {
      const anomalieId = push(
        'Retenue à la source sur loyer non constatée',
        `Le loyer versé à un bailleur personne physique a été comptabilisé pour le seul montant net payé ; la retenue à la source sur revenus fonciers n'a pas été constatée.`,
        rentWithholding.preuves,
        'haute',
      );
      addProposition(anomalieId, rentWithholding);
    }

    const associateAdvance = draftAssociateAdvanceExpense({ documents: dataset.documents, chart: dataset.chart, tiers: dataset.tiers });
    if (associateAdvance) {
      const anomalieId = push(
        'Note de frais avancée par un dirigeant non comptabilisée',
        `Une note de frais réglée personnellement par un dirigeant n'a pas été comptabilisée ; elle est constatée avec la TVA récupérable, en compte courant associé.`,
        associateAdvance.draft.preuves,
        'faible',
      );
      addProposition(anomalieId, associateAdvance.draft);
    }

    const tvaConfig = dataset.fiscal.tva as Record<string, unknown> | undefined;
    const regime = String(tvaConfig?.regime_dossier ?? 'inconnu');
    let tva: VatResult;
    if (regime.toLowerCase() === 'encaissement') {
      const suspended: Record<string, SuspensItem[]> = {};
      for (const bank of dataset.banks) suspended[bank.key] = suspensByBank.get(bank.key) ?? [];
      const priorKey = lockedFin ? `tva_${lockedFin.slice(0, 7)}` : '';
      const priorTva = priorKey ? dataset.priorDeclarations[priorKey] as { credit_anterieur?: unknown } | undefined : undefined;
      const computed = calculateVatEncaissement({
        banks: dataset.banks.map((bank) => ({ key: bank.key, rows: bank.rows })),
        ledger: dataset.ledger,
        openItems: dataset.openItems,
        tiers: dataset.tiers,
        chart: dataset.chart,
        fiscal: dataset.fiscal,
        policy: dataset.policy,
        societe: dataset.societe,
        transfers,
        truncations: dataset.banks.flatMap((bank) => truncationsByBank.get(bank.key) ?? []),
        suspens: suspended,
        period: dataset.period,
        dueDate: nextMonthEnd(dataset.period),
        creditAnterieur: typeof priorTva?.credit_anterieur === 'number' ? priorTva.credit_anterieur : undefined,
      });
      // Ajustements post-calcul, dérivés des propositions RUN3 déjà résolues ci-dessus :
      // (a) une facture scindée entre usage société et usage personnel (P-25/P-26) ne doit
      //     compter, côté TVA, que la part professionnelle — reclassée en immobilisation ;
      // (b) une note de frais avancée par un dirigeant (P-36) et absente du grand livre/relevé
      //     doit être ajoutée à la TVA déductible sur charges (paiement effectif du mois).
      let chargesCentsAdj = cents(computed.tva_deductible_charges);
      let immoCentsAdj = cents(computed.tva_deductible_immobilisations);
      if (personalUseSplit?.excludedPiece) {
        const key = personalUseSplit.excludedPiece.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const originalTvaCents = computed.detail_deductible
          .filter((row) => String((row as { facture?: unknown }).facture ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') === key)
          .reduce((total, row) => total + cents(Number((row as { tva?: unknown }).tva ?? 0)), 0);
        chargesCentsAdj -= originalTvaCents;
        immoCentsAdj += cents(personalUseSplit.companyImmoTva ?? 0);
      }
      if (associateAdvance) chargesCentsAdj += cents(associateAdvance.tva);
      const collecteeCents = cents(computed.tva_collectee_exigible);
      const creditCents = cents(computed.credit_anterieur);
      const dueCents = Math.max(0, collecteeCents - chargesCentsAdj - immoCentsAdj - creditCents);

      tva = {
        regime: computed.regime,
        tva_collectee_exigible: computed.tva_collectee_exigible,
        tva_deductible_charges: mad(chargesCentsAdj / 100),
        tva_deductible_immobilisations: mad(immoCentsAdj / 100),
        credit_anterieur: computed.credit_anterieur,
        tva_due: mad(dueCents / 100),
        echeance: computed.echeance,
        detail_collectee: computed.detail_collectee,
        detail_deductible: computed.detail_deductible,
      };
    } else {
      tva = calculateVat({
        regime,
        ledger: dataset.ledger,
        periodEnd: dataset.periodEnd,
        dueDate: nextMonthEnd(dataset.period),
        accountTypes: vatAccountTypes(dataset.chart),
        nonDeductible: Array.isArray(tvaConfig?.non_deductible) ? tvaConfig.non_deductible.filter((value): value is string => typeof value === 'string') : [],
      });
    }

    const vatSettlement = draftVatSettlement({ policy: dataset.policy, periodEnd: dataset.periodEnd, tva });
    if (vatSettlement) {
      const anomalieId = push(
        'Déclaration de TVA du mois à préparer',
        `L'écriture de règlement/solde de la TVA du mois en régime d'encaissement est proposée depuis le calcul déterministe.`,
        vatSettlement.preuves,
        'haute',
      );
      addProposition(anomalieId, vatSettlement);
    }

    const priorPeriod = lockedFin.slice(0, 7);
    if (priorPeriod) {
      for (const draft of detectVatDeclarationGap({ ledger: dataset.ledger, chart: dataset.chart, priorDeclarations: dataset.priorDeclarations, priorPeriod, fiscal: dataset.fiscal })) pushDraft(draft);
      for (const draft of detectUnpaidWithholdingTax({ ledger: dataset.ledger, chart: dataset.chart, priorDeclarations: dataset.priorDeclarations, fiscal: dataset.fiscal, periodEnd: dataset.periodEnd })) pushDraft(draft);
    }
    for (const draft of detectAnalyticVariances({ ledger: dataset.ledger, history: dataset.history, policy: dataset.policy, period: dataset.period })) pushDraft(draft);

    const rapprochements: Output['rapprochements'] = {};
    const nameTokens = companyNameTokens(String(((dataset.societe as { raison_sociale?: unknown }).raison_sociale) ?? ''));
    const redact = (libelle: string | undefined): string | undefined => redactCompanyName(libelle, nameTokens);
    for (const bank of dataset.banks) {
      const account = bank.header.compte_gl;
      if (typeof account !== 'string' || !account) throw new Error(`Compte GL bancaire absent: ${bank.name}`);
      const checksum = checksums.get(bank.key) ?? verifyStatementChecksum(bank.header, bank.rows);
      const truncations = truncationsByBank.get(bank.key) ?? [];
      const suspens = (suspensByBank.get(bank.key) ?? []).map((item) => ({ ...item, libelle: redact(item.libelle) }));
      const soldeReleve = statementBalance(bank.header);
      const glBefore = accountBalance(dataset, account);
      const correctionsCandidates = [
        ...suspens
          .filter((item) => item.type === 'frais_non_comptabilise' || item.type === 'impaye')
          .map((item) => ({ banque: bank.key, type: item.type, id_ligne: item.id_ligne, libelle: item.libelle, montant: item.montant, date: item.date })),
        ...truncations.map((finding) => ({
          banque: bank.key,
          type: 'troncature',
          id_ligne: finding.id_ligne,
          piece: finding.piece,
          montant_extrait: finding.montant_extrait,
          montant_corrige: finding.montant_corrige,
          ecart: finding.ecart,
        })),
      ];
      const affecting = propositions.filter((proposition) => proposition.lignes.some((line) => line.compte === account));
      const netCents = affecting.reduce((total, proposition) =>
        total + proposition.lignes
          .filter((line) => line.compte === account)
          .reduce((sum, line) => sum + cents(line.debit) - cents(line.credit), 0), 0);
      const glApres = mad(glBefore + netCents / 100);
      const transit = inTransitItems({ key: bank.key, name: bank.name, rows: bank.rows, header: bank.header }, dataset.ledger)
        .map((item) => ({ ...item, libelle: redact(item.libelle) }));
      const transitDeltaCents = transit.reduce((total, item) => total + (item.type === 'remise_non_creditee' ? cents(item.montant) : -cents(item.montant)), 0);
      const ecartResiduel = mad((cents(soldeReleve) + transitDeltaCents - cents(glApres)) / 100);
      rapprochements[bank.key] = {
        solde_releve: soldeReleve,
        solde_gl_avant: glBefore,
        solde_gl_apres: glApres,
        ecart_residuel: ecartResiduel,
        corrections: affecting.map((proposition) => proposition.id),
        corrections_candidates: correctionsCandidates,
        suspens: transit as unknown as Record<string, unknown>[],
        controle_totaux_imprimes: { ...checksum, ecart: mad((cents(checksum.ecart_debit) + cents(checksum.ecart_credit)) / 100) },
      };
    }
    for (const draft of detectLegitimateSuspens(banksLike, dataset.ledger)) pushDraft(draft);

    for (const bank of dataset.banks) {
      const reconciliation = rapprochements[bank.key];
      if (reconciliation.ecart_residuel !== 0) {
        push(
          `Écart de rapprochement bancaire (${bank.key})`,
          'Le solde du relevé et le solde du grand livre ne concordent pas ; aucune correction automatique n’est proposée à cette étape.',
          [`BQ:${bank.key}`, `GL:compte:${String(bank.header.compte_gl ?? 'inconnu')}`],
          'haute',
        );
      }
    }

    return {
      propositions,
      anomalies,
      tva,
      rapprochements,
      questions: questionsFor(anomalies, policyMaximumQuestions(dataset)),
      journal_securite: [],
    };
  }
}