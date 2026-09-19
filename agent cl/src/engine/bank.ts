import { cents, mad } from './money.js';

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
