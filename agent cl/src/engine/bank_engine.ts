import type { Row } from './dataset.js';
import { cents, mad, sum } from './money.js';
import { collectifAccounts } from './integrity.js';

export interface BankSummary {
  solde_releve: number;
  solde_gl_avant: number;
  solde_gl_apres: number;
  ecart_residuel: number;
  corrections: string[];
  suspens: Record<string, unknown>[];
  controle_totaux_imprimes?: Record<string, unknown>;
}

export interface BankRow {
  id_ligne?: string;
  [key: string]: string | undefined;
}

export function matchBankEntries(bankRows: BankRow[], ledgerRows: BankRow[]): { matched: string[]; unmatched: string[] } {
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const bankRow of bankRows) {
    const id = bankRow.id_ligne;
    if (!id) continue;
    const found = ledgerRows.some((ledgerRow) => Object.values(ledgerRow).some((value) => value?.includes(id)));
    (found ? matched : unmatched).push(id);
  }
  return { matched, unmatched };
}

export function reconcileBank(input: {
  statementBalance: number;
  glBefore: number;
  corrections?: number[];
  correctionIds?: string[];
  suspens?: Record<string, unknown>[];
  printedDebit?: number;
  extractedDebit?: number;
  residual?: number;
}): BankSummary {
  const corrections = input.corrections ?? [];
  const adjustment = corrections.reduce((total, value) => total + cents(value), 0);
  const after = mad((cents(input.glBefore) + adjustment) / 100);
  const summary: BankSummary = {
    solde_releve: input.statementBalance,
    solde_gl_avant: input.glBefore,
    solde_gl_apres: after,
    ecart_residuel: input.residual ?? mad((cents(input.statementBalance) - cents(after)) / 100),
    corrections: input.correctionIds ?? [],
    suspens: input.suspens ?? [],
  };
  if (input.printedDebit !== undefined && input.extractedDebit !== undefined) {
    summary.controle_totaux_imprimes = {
      somme_debits_extraits: input.extractedDebit,
      total_debit_imprime: input.printedDebit,
      ecart: mad((cents(input.printedDebit) - cents(input.extractedDebit)) / 100),
    };
  }
  return summary;
}

export interface StatementChecksum {
  solde_initial: number;
  total_debit_extrait: number;
  total_credit_extrait: number;
  solde_final_calcule: number;
  solde_final_imprime: number;
  total_debit_imprime: number;
  total_credit_imprime: number;
  ecart_debit: number;
  ecart_credit: number;
  ecart_solde: number;
  coherent: boolean;
}

export interface TruncationFinding {
  banque: string;
  id_ligne: string;
  piece: string;
  montant_extrait: number;
  montant_corrige: number;
  ecart: number;
}

export interface InternalTransfer {
  montant: number;
  date: string;
  source: { key: string; id_ligne: string };
  cible: { key: string; id_ligne: string };
}

const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const amount = (value: string | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const difference = (printed: number, extracted: number): number => mad((cents(printed) - cents(extracted)) / 100);

export function verifyStatementChecksum(header: Record<string, unknown>, rows: Row[]): StatementChecksum {
  const solde_initial = mad(numberValue(header.solde_initial));
  const total_debit_extrait = sum(rows.map((row) => amount(row.debit)));
  const total_credit_extrait = sum(rows.map((row) => amount(row.credit)));
  const total_debit_imprime = mad(numberValue(header.total_debit_imprime));
  const total_credit_imprime = mad(numberValue(header.total_credit_imprime));
  const solde_final_imprime = mad(numberValue(header.solde_final_imprime));
  const solde_final_calcule = mad((cents(solde_initial) - cents(total_debit_extrait) + cents(total_credit_extrait)) / 100);
  const ecart_debit = difference(total_debit_imprime, total_debit_extrait);
  const ecart_credit = difference(total_credit_imprime, total_credit_extrait);
  const ecart_solde = difference(solde_final_imprime, solde_final_calcule);
  return {
    solde_initial,
    total_debit_extrait,
    total_credit_extrait,
    solde_final_calcule,
    solde_final_imprime,
    total_debit_imprime,
    total_credit_imprime,
    ecart_debit,
    ecart_credit,
    ecart_solde,
    coherent: ecart_debit === 0 && ecart_credit === 0 && ecart_solde === 0,
  };
}

const PIECE_PATTERN = /[A-Z]{2,4}-\d{2,4}(?:-\d{3,5})?/;

const collectorPrefixes = (chart: Row[]): string[] => (chart.length > 0 ? [...collectifAccounts(chart)] : ['4411']);

function invoiceTotal(ledger: Row[], piece: string, isCollector: (compte: string) => boolean): number | undefined {
  let found = false;
  let totalCents = 0;
  for (const row of ledger) {
    if (row.piece !== piece) continue;
    const compte = row.compte ?? '';
    if (!isCollector(compte)) continue;
    if (cents(amount(row.credit)) === 0) continue;
    found = true;
    totalCents += cents(amount(row.credit));
  }
  return found ? mad(totalCents / 100) : undefined;
}

export function detectTruncations(
  bank: { key: string; rows: Row[] },
  checksum: StatementChecksum,
  ledger: Row[],
  chart: Row[] = [],
): TruncationFinding[] {
  const prefixes = collectorPrefixes(chart);
  const isCollector = (compte: string): boolean => prefixes.some((prefix) => compte.startsWith(prefix));
  const findings: TruncationFinding[] = [];
  const scan = (ecart: number, senses: Array<{ amount: string | undefined; id_ligne: string | undefined; libelle: string | undefined }>): void => {
    if (cents(ecart) === 0) return;
    for (const row of senses) {
      const id_ligne = row.id_ligne;
      if (!id_ligne) continue;
      const libelle = row.libelle;
      if (!libelle) continue;
      const piece = libelle.match(PIECE_PATTERN)?.[0];
      if (!piece) continue;
      const ttc = invoiceTotal(ledger, piece, isCollector);
      if (ttc === undefined) continue;
      const montant_extrait = mad(amount(row.amount));
      if (cents(montant_extrait) + cents(ecart) !== cents(ttc)) continue;
      findings.push({
        banque: bank.key,
        id_ligne,
        piece,
        montant_extrait,
        montant_corrige: ttc,
        ecart: mad((cents(ttc) - cents(montant_extrait)) / 100),
      });
    }
  };
  scan(checksum.ecart_debit, bank.rows.filter((row) => cents(amount(row.debit)) !== 0).map((row) => ({ amount: row.debit, id_ligne: row.id_ligne, libelle: row.libelle })));
  scan(checksum.ecart_credit, bank.rows.filter((row) => cents(amount(row.credit)) !== 0).map((row) => ({ amount: row.credit, id_ligne: row.id_ligne, libelle: row.libelle })));
  return findings;
}

const transferMarker = (key: string, id: string): string => `${key}\u0000${id}`;

export function detectInternalTransfers(banks: { key: string; rows: Row[] }[]): InternalTransfer[] {
  const consumed = new Set<string>();
  const isConsumed = (key: string, id: string): boolean => consumed.has(transferMarker(key, id));
  const debits: Array<{ key: string; id: string; date: string; cents: number }> = [];
  const credits: Array<{ key: string; id: string; date: string; cents: number }> = [];
  for (const bank of banks) {
    for (const row of bank.rows) {
      const id = row.id_ligne;
      const date = row.date_operation;
      if (!id || !date) continue;
      const debitCents = cents(amount(row.debit));
      const creditCents = cents(amount(row.credit));
      if (debitCents > 0 && creditCents === 0) debits.push({ key: bank.key, id, date, cents: debitCents });
      if (creditCents > 0 && debitCents === 0) credits.push({ key: bank.key, id, date, cents: creditCents });
    }
  }
  const transfers: InternalTransfer[] = [];
  for (const debit of debits) {
    if (isConsumed(debit.key, debit.id)) continue;
    const credit = credits.find((candidate) =>
      !isConsumed(candidate.key, candidate.id) &&
      candidate.key !== debit.key &&
      candidate.date === debit.date &&
      candidate.cents === debit.cents,
    );
    if (!credit) continue;
    consumed.add(transferMarker(debit.key, debit.id));
    consumed.add(transferMarker(credit.key, credit.id));
    transfers.push({
      montant: mad(debit.cents / 100),
      date: debit.date,
      source: { key: debit.key, id_ligne: debit.id },
      cible: { key: credit.key, id_ligne: credit.id },
    });
  }
  return transfers;
}

export type SuspensType = 'frais_non_comptabilise' | 'impaye' | 'remise_non_creditee' | 'cheque_emis_non_debite' | 'encaissement_non_comptabilise' | 'non_categorise';

export interface SuspensItem {
  type: SuspensType;
  id_ligne?: string;
  ref?: string;
  libelle?: string;
  montant: number;
  date?: string;
  montant_corrige?: number;
  piece?: string;
}

export interface LedgerMatchResult {
  matchedBank: string[];
  suspens: SuspensItem[];
}

const FEE_TOKENS = ['frais', 'commission', 'tenue', 'com'];
const FEE_PATTERN = new RegExp(`\\b(?:${FEE_TOKENS.join('|')})\\b`, 'i');
const NUMERIC_REF_PATTERN = /\d{5,}/g;

const hasFeeToken = (libelle: string | undefined): boolean => FEE_PATTERN.test(libelle ?? '');

const bankRefToken = (libelle: string | undefined): string | undefined => {
  const match = (libelle ?? '').match(PIECE_PATTERN);
  return match ? match[0].toUpperCase() : undefined;
};

const numericTokensOf = (libelle: string | undefined): string[] => (libelle ?? '').match(NUMERIC_REF_PATTERN) ?? [];

const sharesNumericRef = (a: string | undefined, b: string | undefined): boolean => {
  const tokensA = numericTokensOf(a);
  const tokensB = numericTokensOf(b);
  for (const token of tokensA) {
    if (tokensB.includes(token)) return true;
  }
  return false;
};

const isOnAccount = (row: Row, bankAccount: string): boolean => (row.compte ?? '') === bankAccount;

export function matchBankToLedger(bank: { key: string; rows: Row[] }, ledger: Row[], bankAccount: string): LedgerMatchResult {
  const matchedBank: string[] = [];
  const suspens: SuspensItem[] = [];
  const matchedGl = new Set<number>();

  const candidateGlRows = (): Array<{ index: number; row: Row }> => {
    const candidates: Array<{ index: number; row: Row }> = [];
    ledger.forEach((row, index) => {
      if (!matchedGl.has(index) && isOnAccount(row, bankAccount)) candidates.push({ index, row });
    });
    return candidates;
  };

  const sameReference = (bankRow: Row, glRow: Row): boolean => {
    const idLigne = bankRow.id_ligne ?? '';
    const strictRef = idLigne.length > 0 && (glRow.ref_banque ?? '') === idLigne;
    const token = bankRefToken(bankRow.libelle);
    const glRefs = [glRow.piece ?? '', glRow.ref_banque ?? ''].map((value) => value.toUpperCase());
    return strictRef || (token !== undefined && glRefs.includes(token));
  };

  const sameAmount = (bankRow: Row, glRow: Row): boolean => {
    const bankDebit = cents(amount(bankRow.debit));
    const bankCredit = cents(amount(bankRow.credit));
    const glDebit = cents(amount(glRow.debit));
    const glCredit = cents(amount(glRow.credit));
    if (bankDebit > 0 && bankCredit === 0) return glCredit === bankDebit && glDebit === 0;
    if (bankCredit > 0 && bankDebit === 0) return glDebit === bankCredit && glCredit === 0;
    return false;
  };

  const directlyMatched = new Set<number>();
  bank.rows.forEach((bankRow, bankIndex) => {
    if (cents(amount(bankRow.debit)) === 0 && cents(amount(bankRow.credit)) === 0) return;
    const match = candidateGlRows().find(({ row }) => sameReference(bankRow, row) && sameAmount(bankRow, row));
    if (!match) return;
    matchedGl.add(match.index);
    directlyMatched.add(bankIndex);
    if (bankRow.id_ligne) matchedBank.push(bankRow.id_ligne);
  });

  const unmatchedCredits: Row[] = [];
  bank.rows.forEach((bankRow, bankIndex) => {
    if (directlyMatched.has(bankIndex)) return;
    const bankDebit = cents(amount(bankRow.debit));
    const bankCredit = cents(amount(bankRow.credit));
    if (bankDebit === 0 && bankCredit === 0) return;
    if (bankDebit > 0) {
      if (hasFeeToken(bankRow.libelle)) {
        suspens.push({ type: 'frais_non_comptabilise', id_ligne: bankRow.id_ligne, libelle: bankRow.libelle, montant: mad(amount(bankRow.debit)), date: bankRow.date_operation });
        return;
      }
      const creditIndex = unmatchedCredits.findIndex((credit) => cents(amount(credit.credit)) === bankDebit && sharesNumericRef(bankRow.libelle, credit.libelle));
      if (creditIndex >= 0) {
        unmatchedCredits.splice(creditIndex, 1);
        suspens.push({ type: 'impaye', id_ligne: bankRow.id_ligne, libelle: bankRow.libelle, montant: mad(amount(bankRow.debit)), date: bankRow.date_operation });
        return;
      }
      suspens.push({ type: 'non_categorise', id_ligne: bankRow.id_ligne, libelle: bankRow.libelle, montant: mad(amount(bankRow.debit)), date: bankRow.date_operation });
      return;
    }
    unmatchedCredits.push(bankRow);
  });

  for (const credit of unmatchedCredits) {
    suspens.push({ type: 'encaissement_non_comptabilise', id_ligne: credit.id_ligne, libelle: credit.libelle, montant: mad(amount(credit.credit)), date: credit.date_operation });
  }

  ledger.forEach((glRow, index) => {
    if (matchedGl.has(index) || !isOnAccount(glRow, bankAccount)) return;
    const glDebit = cents(amount(glRow.debit));
    const glCredit = cents(amount(glRow.credit));
    const piece = glRow.piece ?? '';
    const ref = piece.length > 0 ? piece : undefined;
    const libelle = (glRow.libelle ?? '').length > 0 ? glRow.libelle : ref;
    if (glDebit > 0) {
      suspens.push({ type: 'remise_non_creditee', ref, libelle, montant: mad(amount(glRow.debit)), date: glRow.date_ecriture, piece: ref });
      return;
    }
    if (glCredit > 0) {
      suspens.push({ type: 'cheque_emis_non_debite', ref, libelle, montant: mad(amount(glRow.credit)), date: glRow.date_ecriture, piece: ref });
    }
  });

  return { matchedBank, suspens };
}