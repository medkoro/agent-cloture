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