// Génération déterministe de propositions d'écritures correctrices à partir des données
// injectées (grand livre, relevés bancaires, plan comptable, tiers, paramètres fiscaux).
// Aucun montant, numéro de compte ou identifiant tiers n'est en dur : tout est dérivé des
// lignes reçues en paramètre. Si une donnée manque, la fonction ne propose rien (elle laisse
// l'anomalie parente seule porter le signal) plutôt que d'inventer un compte ou un montant.
import type { EntryLine } from '../contracts/output.js';
import type { JsonObject, Row } from './dataset.js';
import type { InternalTransfer, SuspensItem, TruncationFinding } from './bank_engine.js';
import { cents, mad } from './money.js';
import { vatAccountTypes } from './vat_engine.js';

export interface PostingDraft {
  type: string;
  date: string;
  journal: string;
  libelle: string;
  certitude: string;
  preuves: string[];
  lignes: EntryLine[];
}

interface BankLike {
  key: string;
  name: string;
  rows: Row[];
  header: JsonObject;
}

const amount = (value: string | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalized = (value: unknown): string =>
  String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function findAccountByLabel(chart: Row[], words: string[], nature?: string): string | undefined {
  const needles = words.map((word) => normalized(word));
  const match = chart.find((row) => {
    if (nature && String(row.nature ?? '') !== nature) return false;
    const text = normalized(row.libelle);
    return needles.every((needle) => text.includes(needle));
  });
  return match?.code;
}

function tiersIndex(tiers: Row[]): Map<string, Row> {
  return new Map(tiers.map((row) => [String(row.code ?? ''), row]));
}

function bankRefFor(bank: BankLike, idLigne: string): string {
  return `${bank.name.toUpperCase()}:${idLigne}`.toUpperCase();
}

function ledgerBankLine(ledger: Row[], bankAccount: string, bank: BankLike, idLigne: string): Row | undefined {
  const needle = bankRefFor(bank, idLigne);
  return ledger.find((row) => row.compte === bankAccount && (row.ref_banque ?? '').toUpperCase() === needle);
}

function isRecordedOnBank(ledger: Row[], bankAccount: string, idLigne: string): boolean {
  const needle = idLigne.toUpperCase();
  return ledger.some((row) =>
    row.compte === bankAccount &&
    ((row.piece ?? '').toUpperCase() === needle || (row.ref_banque ?? '').toUpperCase().endsWith(`:${needle}`)));
}

// ── P-01-like : compléter une écriture à sens unique via le justificatif qui l'identifie ──
export function draftComplementForUnbalancedEntry(
  ecritureId: string,
  ledger: Row[],
  documents: Row[],
  tiers: Row[],
): PostingDraft | undefined {
  const lines = ledger.filter((row) => row.ecriture_id === ecritureId);
  if (lines.length === 0) return undefined;
  const ecartCents = lines.reduce((total, row) => total + cents(amount(row.debit)) - cents(amount(row.credit)), 0);
  if (ecartCents === 0) return undefined;
  const piece = lines[0].piece || ecritureId;
  const doc = documents.find((row) => (row.statut_plateforme ?? '').toUpperCase().includes(piece.toUpperCase()));
  if (!doc || !doc.tiers) return undefined;
  const tier = tiersIndex(tiers).get(doc.tiers);
  if (!tier || !tier.compte) return undefined;
  const debit = ecartCents < 0 ? mad(-ecartCents / 100) : 0;
  const credit = ecartCents > 0 ? mad(ecartCents / 100) : 0;
  return {
    type: 'complement',
    date: lines[0].date_ecriture ?? '',
    journal: lines[0].journal || 'OD',
    libelle: `Complément de l'écriture incomplète ${piece}`,
    certitude: 'certaine',
    preuves: [`GL:${ecritureId}`, `DOC:${doc.fichier}`],
    lignes: [{ compte: tier.compte, tiers: tier.code, debit, credit }],
  };
}

// ── P-02-like : contre-passer les factures fournisseurs saisies en double ──
function invoiceSignature(lines: Row[]): string {
  const totals = new Map<string, number>();
  for (const row of lines) {
    const compte = row.compte ?? '';
    const debitCents = cents(amount(row.debit));
    const creditCents = cents(amount(row.credit));
    if (debitCents) totals.set(`${compte}|D`, (totals.get(`${compte}|D`) ?? 0) + debitCents);
    if (creditCents) totals.set(`${compte}|C`, (totals.get(`${compte}|C`) ?? 0) + creditCents);
  }
  return [...totals.entries()].sort().map(([key, value]) => `${key}:${value}`).join(';');
}

export interface DuplicateReversal {
  duplicateEcritureId: string;
  keeperEcritureId: string;
  draft: PostingDraft;
}

export function findDuplicateInvoiceReversals(ledger: Row[], correctionDate: string): DuplicateReversal[] {
  const byEcriture = new Map<string, Row[]>();
  for (const row of ledger) {
    if (!row.ecriture_id) continue;
    const list = byEcriture.get(row.ecriture_id);
    if (list) list.push(row);
    else byEcriture.set(row.ecriture_id, [row]);
  }
  const buckets = new Map<string, { ecriture_id: string; lines: Row[]; hasJustificatif: boolean }[]>();
  for (const [ecriture_id, lines] of byEcriture) {
    const journal = lines[0]?.journal ?? '';
    const tiers = lines.find((row) => row.tiers)?.tiers ?? '';
    if (!tiers) continue;
    const key = `${journal}|${tiers}|${invoiceSignature(lines)}`;
    const entry = { ecriture_id, lines, hasJustificatif: lines.some((row) => (row.justificatif ?? '').length > 0) };
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }
  const results: DuplicateReversal[] = [];
  for (const entries of buckets.values()) {
    if (entries.length < 2) continue;
    const keepers = entries.filter((entry) => entry.hasJustificatif);
    const duplicates = entries.filter((entry) => !entry.hasJustificatif);
    if (keepers.length === 0 || duplicates.length === 0) continue;
    for (const duplicate of duplicates) {
      const piece = duplicate.lines[0]?.piece || duplicate.ecriture_id;
      const lignes: EntryLine[] = duplicate.lines
        .filter((row) => amount(row.debit) > 0 || amount(row.credit) > 0)
        .map((row) => ({
          compte: row.compte ?? '',
          tiers: row.tiers || undefined,
          debit: amount(row.credit),
          credit: amount(row.debit),
        }));
      results.push({
        duplicateEcritureId: duplicate.ecriture_id,
        keeperEcritureId: keepers[0].ecriture_id,
        draft: {
          type: 'standard',
          date: correctionDate,
          journal: 'OD',
          libelle: `Contre-passation du doublon ${piece}`,
          certitude: 'certaine',
          preuves: [`GL:${duplicate.ecriture_id}`, `GL:${keepers[0].ecriture_id}`],
          lignes,
        },
      });
    }
  }
  return results;
}

// ── P-03-like : corriger un montant tronqué à l'extraction bancaire ──
export function draftTruncationCorrection(
  finding: TruncationFinding,
  banks: BankLike[],
  ledger: Row[],
): PostingDraft | undefined {
  const bank = banks.find((candidate) => candidate.key === finding.banque);
  if (!bank) return undefined;
  const bankAccount = String(bank.header.compte_gl ?? '');
  if (!bankAccount) return undefined;
  const bankLine = ledgerBankLine(ledger, bankAccount, bank, finding.id_ligne);
  if (!bankLine || !bankLine.ecriture_id) return undefined;
  const sibling = ledger.find((row) =>
    row.ecriture_id === bankLine.ecriture_id &&
    row.compte !== bankAccount &&
    (amount(row.debit) > 0 || amount(row.credit) > 0));
  if (!sibling) return undefined;
  const ecartAmount = mad(Math.abs(cents(finding.ecart)) / 100);
  const siblingIsDebit = amount(sibling.debit) > 0;
  const lignes: EntryLine[] = siblingIsDebit
    ? [
      { compte: sibling.compte ?? '', tiers: sibling.tiers || undefined, debit: ecartAmount, credit: 0 },
      { compte: bankAccount, debit: 0, credit: ecartAmount },
    ]
    : [
      { compte: sibling.compte ?? '', tiers: sibling.tiers || undefined, debit: 0, credit: ecartAmount },
      { compte: bankAccount, debit: ecartAmount, credit: 0 },
    ];
  const bankRow = bank.rows.find((row) => row.id_ligne === finding.id_ligne);
  return {
    type: 'standard',
    date: bankRow?.date_operation || sibling.date_ecriture || '',
    journal: 'OD',
    libelle: `Correction du montant tronqué ${finding.id_ligne} (${finding.montant_corrige} et non ${finding.montant_extrait})`,
    certitude: 'certaine',
    preuves: [`BQ:${finding.banque}:${finding.id_ligne}`, `GL:${bankLine.ecriture_id}`, `CALC:${finding.montant_extrait}+${ecartAmount}=${finding.montant_corrige}`],
    lignes,
  };
}

// ── P-04-like : frais bancaires débités mais jamais saisis au grand livre ──
const FEE_PATTERN = /\b(?:frais|commission|tenue|com)\b/i;

function feesRateFromFiscal(fiscal: JsonObject): number | undefined {
  const tva = fiscal.tva as { taux_par_nature?: unknown } | undefined;
  const nature = (tva?.taux_par_nature as Record<string, unknown> | undefined)?.frais_bancaires;
  const parsed = Number(nature);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface FeePosting {
  bankKey: string;
  idLigne: string;
  draft: PostingDraft;
}

export function draftUnrecordedFeePostings(params: {
  banks: BankLike[];
  ledger: Row[];
  chart: Row[];
  fiscal: JsonObject;
}): FeePosting[] {
  const rate = feesRateFromFiscal(params.fiscal);
  if (rate === undefined) return [];
  const chargeAccount = findAccountByLabel(params.chart, ['bancaire'], 'CHARGE');
  const vatAccount = vatAccountTypes(params.chart).charges[0];
  if (!chargeAccount || !vatAccount) return [];
  const results: FeePosting[] = [];
  for (const bank of params.banks) {
    const bankAccount = String(bank.header.compte_gl ?? '');
    if (!bankAccount) continue;
    for (const row of bank.rows) {
      const idLigne = row.id_ligne ?? '';
      if (!idLigne || !FEE_PATTERN.test(row.libelle ?? '')) continue;
      const debit = amount(row.debit);
      if (debit <= 0) continue;
      if (isRecordedOnBank(params.ledger, bankAccount, idLigne)) continue;
      const ttcCents = cents(debit);
      const htCents = Math.round((ttcCents * 100) / (100 + rate));
      const tvaCents = ttcCents - htCents;
      const ht = mad(htCents / 100);
      const tva = mad(tvaCents / 100);
      results.push({
        bankKey: bank.key,
        idLigne,
        draft: {
          type: 'standard',
          date: row.date_operation ?? '',
          journal: 'OD',
          libelle: `Frais bancaire non comptabilisé (${bank.key}:${idLigne})`,
          certitude: 'certaine',
          preuves: [`BQ:${bank.key}:${idLigne}`, `CALC:${ht}+${tva}=${mad(debit)}`],
          lignes: [
            { compte: chargeAccount, debit: ht, credit: 0 },
            { compte: vatAccount, debit: tva, credit: 0 },
            { compte: bankAccount, debit: 0, credit: mad(debit) },
          ],
        },
      });
    }
  }
  return results;
}

// ── P-06-like : extourner un chèque client impayé ──
const LEGAL_FORM = /^(?:sarl|sas|sua|sa|sci|eurl|sca|snc|ei|srl|gmbh|llc|ltd|inc|co|saas)$/;
const tierTokens = (name: string): string[] =>
  normalized(name).split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !LEGAL_FORM.test(token));

function matchesTier(libelle: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const text = normalized(libelle);
  return tokens.every((token) => text.includes(token));
}

function findTierByLibelle(tiers: Row[], type: string, libelle: string): Row | undefined {
  let best: Row | undefined;
  let bestScore = -1;
  for (const tier of tiers) {
    if (String(tier.type ?? '') !== type) continue;
    const tokens = tierTokens(String(tier.nom ?? ''));
    if (!matchesTier(libelle, tokens)) continue;
    const score = tokens.join('').length;
    if (score > bestScore) {
      best = tier;
      bestScore = score;
    }
  }
  return best;
}

export interface ChequePosting {
  bankKey: string;
  idLigne: string;
  draft: PostingDraft;
}

export function draftReturnedChequePostings(params: {
  suspensByBank: Record<string, SuspensItem[]>;
  banks: BankLike[];
  tiers: Row[];
}): ChequePosting[] {
  const results: ChequePosting[] = [];
  for (const [bankKey, items] of Object.entries(params.suspensByBank)) {
    const bank = params.banks.find((candidate) => candidate.key === bankKey);
    const bankAccount = bank ? String(bank.header.compte_gl ?? '') : '';
    if (!bankAccount) continue;
    for (const item of items) {
      if (item.type !== 'impaye') continue;
      const tier = findTierByLibelle(params.tiers, 'client', item.libelle ?? '');
      if (!tier || !tier.compte) continue;
      const idLigne = item.id_ligne ?? '';
      results.push({
        bankKey,
        idLigne,
        draft: {
          type: 'standard',
          date: item.date ?? '',
          journal: 'OD',
          libelle: `Extourne chèque client impayé (${bankKey}:${idLigne})`,
          certitude: 'certaine',
          preuves: [`BQ:${bankKey}:${idLigne}`],
          lignes: [
            { compte: tier.compte, tiers: tier.code, debit: item.montant, credit: 0 },
            { compte: bankAccount, debit: 0, credit: item.montant },
          ],
        },
      });
    }
  }
  return results;
}

// ── P-07-like : reclasser un virement interne enregistré à tort en produit ──
export interface TransferReclassification {
  ecritureId: string;
  draft: PostingDraft;
}

export function draftInternalTransferReclassifications(params: {
  transfers: InternalTransfer[];
  banks: BankLike[];
  ledger: Row[];
  chart: Row[];
}): TransferReclassification[] {
  const virementsAccount = findAccountByLabel(params.chart, ['virement', 'fonds']);
  if (!virementsAccount) return [];
  const natureByCode = new Map(params.chart.map((row) => [String(row.code ?? ''), String(row.nature ?? '')]));
  const results: TransferReclassification[] = [];
  for (const transfer of params.transfers) {
    for (const leg of [transfer.source, transfer.cible]) {
      const bank = params.banks.find((candidate) => candidate.key === leg.key);
      if (!bank) continue;
      const bankAccount = String(bank.header.compte_gl ?? '');
      if (!bankAccount) continue;
      const bankLine = ledgerBankLine(params.ledger, bankAccount, bank, leg.id_ligne);
      if (!bankLine || !bankLine.ecriture_id) continue;
      const sibling = params.ledger.find((row) =>
        row.ecriture_id === bankLine.ecriture_id &&
        row.compte !== bankAccount &&
        (amount(row.debit) > 0 || amount(row.credit) > 0));
      if (!sibling) continue;
      if (natureByCode.get(sibling.compte ?? '') !== 'PRODUIT') continue;
      const montant = mad(amount(sibling.credit) > 0 ? amount(sibling.credit) : amount(sibling.debit));
      results.push({
        ecritureId: bankLine.ecriture_id,
        draft: {
          type: 'standard',
          date: transfer.date,
          journal: 'OD',
          libelle: `Virement interne enregistré à tort en produit (${leg.key}:${leg.id_ligne})`,
          certitude: 'certaine',
          preuves: [`BQ:${transfer.source.key}:${transfer.source.id_ligne}`, `BQ:${transfer.cible.key}:${transfer.cible.id_ligne}`, `GL:${bankLine.ecriture_id}`],
          lignes: [
            { compte: sibling.compte ?? '', debit: montant, credit: 0 },
            { compte: virementsAccount, debit: 0, credit: montant },
          ],
        },
      });
    }
  }
  return results;
}

// ── P-08-like : reclasser un retrait DAB/GAB comptabilisé en charge au lieu de la caisse ──
const ATM_PATTERN = /\b(?:gab|dab)\b/i;

export interface CashWithdrawalReclassification {
  bankKey: string;
  idLigne: string;
  draft: PostingDraft;
}

export function draftCashWithdrawalReclassifications(params: {
  banks: BankLike[];
  ledger: Row[];
  chart: Row[];
  societe: JsonObject;
}): CashWithdrawalReclassification[] {
  const caisseCompte = String(((params.societe.caisse as { compte?: unknown } | undefined)?.compte) ?? '');
  if (!caisseCompte) return [];
  const natureByCode = new Map(params.chart.map((row) => [String(row.code ?? ''), String(row.nature ?? '')]));
  const results: CashWithdrawalReclassification[] = [];
  for (const bank of params.banks) {
    const bankAccount = String(bank.header.compte_gl ?? '');
    if (!bankAccount) continue;
    for (const row of bank.rows) {
      const idLigne = row.id_ligne ?? '';
      if (!idLigne || !ATM_PATTERN.test(row.libelle ?? '')) continue;
      const debit = amount(row.debit);
      if (debit <= 0) continue;
      const bankLine = ledgerBankLine(params.ledger, bankAccount, bank, idLigne);
      if (!bankLine || !bankLine.ecriture_id) continue;
      const sibling = params.ledger.find((candidate) =>
        candidate.ecriture_id === bankLine.ecriture_id &&
        candidate.compte !== bankAccount &&
        amount(candidate.debit) > 0);
      if (!sibling || sibling.compte === caisseCompte) continue;
      if (natureByCode.get(sibling.compte ?? '') !== 'CHARGE') continue;
      results.push({
        bankKey: bank.key,
        idLigne,
        draft: {
          type: 'standard',
          date: row.date_operation ?? '',
          journal: 'OD',
          libelle: `Retrait DAB reclassé en alimentation de caisse (${bank.key}:${idLigne})`,
          certitude: 'certaine',
          preuves: [`BQ:${bank.key}:${idLigne}`, `GL:${bankLine.ecriture_id}`],
          lignes: [
            { compte: caisseCompte, debit: mad(debit), credit: 0 },
            { compte: sibling.compte ?? '', debit: 0, credit: mad(debit) },
          ],
        },
      });
    }
  }
  return results;
}

// ── Rapprochement : éléments en transit (non encore imprimés sur le relevé) ──
export interface InTransitItem {
  type: 'remise_non_creditee' | 'cheque_emis_non_debite';
  montant: number;
  ref?: string;
  libelle?: string;
  date?: string;
}

export function inTransitItems(bank: BankLike, ledger: Row[]): InTransitItem[] {
  const bankAccount = String(bank.header.compte_gl ?? '');
  if (!bankAccount) return [];
  const items: InTransitItem[] = [];
  for (const row of ledger) {
    if (row.compte !== bankAccount || row.ref_banque) continue;
    const debit = amount(row.debit);
    const credit = amount(row.credit);
    if (debit > 0) {
      const onStatement = bank.rows.some((candidate) => cents(amount(candidate.credit)) === cents(debit));
      if (!onStatement) items.push({ type: 'remise_non_creditee', montant: mad(debit), ref: row.piece || undefined, libelle: row.libelle, date: row.date_ecriture });
    } else if (credit > 0) {
      const onStatement = bank.rows.some((candidate) => cents(amount(candidate.debit)) === cents(credit));
      if (!onStatement) items.push({ type: 'cheque_emis_non_debite', montant: mad(credit), ref: row.piece || undefined, libelle: row.libelle, date: row.date_ecriture });
    }
  }
  return items;
}
