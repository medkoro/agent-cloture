import { mad } from './money.js';

export interface VatRow {
  compte?: string;
  debit?: string | number;
  credit?: string | number;
  [key: string]: unknown;
}

export interface VatInput {
  regime: string;
  ledger: VatRow[];
  creditAnterieur?: number;
  dueDate?: string;
  periodEnd?: string;
  accountTypes?: {
    collected: string[];
    charges: string[];
    immobilisations: string[];
  };
  nonDeductible?: string[];
}

export interface VatResult {
  regime: string;
  tva_collectee_exigible: number;
  tva_deductible_charges: number;
  tva_deductible_immobilisations: number;
  credit_anterieur: number;
  tva_due: number;
  echeance: string;
  detail_collectee: VatRow[];
  detail_deductible: VatRow[];
}

const amount = (value: string | number | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalized = (value: unknown): string => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function hasVatLabel(row: VatRow, words: string[]): boolean {
  const text = normalized(`${row.compte_libelle ?? ''} ${row.libelle ?? ''}`);
  return words.some((word) => text.includes(normalized(word)));
}

function inAccountType(row: VatRow, accounts: string[] | undefined, labels: string[]): boolean {
  return accounts ? accounts.includes(String(row.compte ?? '')) : hasVatLabel(row, labels);
}

function isNonDeductible(row: VatRow, rules: string[] = []): boolean {
  const text = normalized(`${row.compte_libelle ?? ''} ${row.libelle ?? ''}`);
  return rules.some((rule) => rule.split(/[^a-z0-9]+/).filter((token) => token.length >= 6).some((token) => text.includes(token) || text.includes(token.slice(0, -2))));
}

export function calculateVat(input: VatInput): VatResult {
  const collecteeRows = input.ledger.filter((row) => inAccountType(row, input.accountTypes?.collected, ['tva facturee', 'tva collectee']) && amount(row.credit) > 0);
  const chargeRows = input.ledger.filter((row) => inAccountType(row, input.accountTypes?.charges, ['tva recuperable sur charges']) && amount(row.debit) > 0 && !isNonDeductible(row, input.nonDeductible));
  const assetRows = input.ledger.filter((row) => inAccountType(row, input.accountTypes?.immobilisations, ['tva recuperable sur les immobilisations', 'tva recuperable sur immobilisations']) && amount(row.debit) > 0 && !isNonDeductible(row, input.nonDeductible));
  const collectee = mad(collecteeRows.reduce((total, row) => total + amount(row.credit), 0));
  const charges = mad(chargeRows.reduce((total, row) => total + amount(row.debit), 0));
  const immobilisations = mad(assetRows.reduce((total, row) => total + amount(row.debit), 0));
  const credit = mad(input.creditAnterieur ?? 0);
  const due = mad(Math.max(0, collectee - charges - immobilisations - credit));

  return {
    regime: input.regime,
    tva_collectee_exigible: collectee,
    tva_deductible_charges: charges,
    tva_deductible_immobilisations: immobilisations,
    credit_anterieur: credit,
    tva_due: due,
    echeance: input.dueDate ?? input.periodEnd ?? '',
    detail_collectee: collecteeRows,
    detail_deductible: [...chargeRows, ...assetRows],
  };
}
