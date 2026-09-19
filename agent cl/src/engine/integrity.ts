import type { Row } from './dataset.js';
import { cents, mad } from './money.js';

export type LedgerIssueType = 'ecriture_desequilibree' | 'periode_verrouillee' | 'compte_collectif';

export interface LedgerIssue {
  type: LedgerIssueType;
  ecriture_id?: string;
  piece?: string;
  compte?: string;
  date_ecriture?: string;
  ecart?: number;
}

export function collectifAccounts(chart: Row[]): Set<string> {
  return new Set(chart.filter((row) => row.compte_parent).map((row) => row.compte_parent));
}

const amount = (value: string | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

function balance(lines: Row[]): number {
  const totalCents = lines.reduce(
    (total, row) => total + cents(amount(row.debit)) - cents(amount(row.credit)),
    0,
  );
  return mad(totalCents / 100);
}

export function checkLedgerIntegrity(ledger: Row[], chart: Row[], lockDate: string): LedgerIssue[] {
  const collectifs = collectifAccounts(chart);
  const entries = new Map<string, Row[]>();
  for (const row of ledger) {
    if (!row.ecriture_id) continue;
    const lines = entries.get(row.ecriture_id);
    if (lines) lines.push(row);
    else entries.set(row.ecriture_id, [row]);
  }

  const issues: LedgerIssue[] = [];
  for (const [ecriture_id, lines] of entries) {
    const ecart = balance(lines);
    if (ecart !== 0) issues.push({ type: 'ecriture_desequilibree', ecriture_id, ecart });
    const locked = lines.find((row) => row.date_ecriture && row.date_ecriture <= lockDate);
    if (locked) issues.push({ type: 'periode_verrouillee', ecriture_id, piece: locked.piece, date_ecriture: locked.date_ecriture });
    const collectif = lines.find((row) => row.compte && collectifs.has(row.compte));
    if (collectif) issues.push({ type: 'compte_collectif', ecriture_id, piece: collectif.piece, compte: collectif.compte });
  }
  return issues;
}