import type { Anomaly, Output, Proposition } from '../contracts/output.js';
import { calculateAssets } from './assets.js';
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
  findDuplicateInvoiceReversals,
  inTransitItems,
  type PostingDraft,
} from './postings.js';
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
    // manquante réelle (ex. TelcoNet). Les lignes bancaires (ref_banque renseignée) et les
    // écritures déjà traitées ailleurs (période verrouillée, doublon) ne sont pas reprises ici.
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
    const addProposition = (anomalieId: string, draft: PostingDraft, id?: string): void => {
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
      tva = {
        regime: computed.regime,
        tva_collectee_exigible: computed.tva_collectee_exigible,
        tva_deductible_charges: computed.tva_deductible_charges,
        tva_deductible_immobilisations: computed.tva_deductible_immobilisations,
        credit_anterieur: computed.credit_anterieur,
        tva_due: computed.tva_due,
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

    const priorPeriod = lockedFin.slice(0, 7);
    if (priorPeriod) {
      for (const draft of detectVatDeclarationGap({ ledger: dataset.ledger, chart: dataset.chart, priorDeclarations: dataset.priorDeclarations, priorPeriod, fiscal: dataset.fiscal })) pushDraft(draft);
      for (const draft of detectUnpaidWithholdingTax({ ledger: dataset.ledger, chart: dataset.chart, priorDeclarations: dataset.priorDeclarations, fiscal: dataset.fiscal, periodEnd: dataset.periodEnd })) pushDraft(draft);
    }
    for (const draft of detectAnalyticVariances({ ledger: dataset.ledger, history: dataset.history, policy: dataset.policy, period: dataset.period })) pushDraft(draft);

    const assets = calculateAssets({ rows: dataset.assets, periodEnd: dataset.periodEnd });
    if (assets.assets.length > 0) {
      push(
        'Dotation d’immobilisations à revoir',
        'Une dotation déterministe a été calculée depuis le registre, mais aucune écriture n’est générée sans validation des comptes et des règles applicables.',
        assets.assets.map((asset) => `IMMO:${asset.id ?? 'inconnu'}`),
      );
    }

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