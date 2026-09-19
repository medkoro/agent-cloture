import { mad } from './money.js';

export interface CutoffRow {
  piece?: string;
  date_ecriture?: string;
  date_piece?: string;
  debit?: string | number;
  credit?: string | number;
}

export interface CutoffRule {
  id: string;
  date: string;
  contre_passation_le?: string;
  montant: number;
  nature: string;
}

export function cutoffRules(input: {
  periodStart: string;
  rows: CutoffRow[];
  classify: (rows: CutoffRow[]) => { nature: string; reversalDate?: string } | undefined;
}): CutoffRule[] {
  const groups = new Map<string, CutoffRow[]>();
  for (const row of input.rows) {
    if (!row.piece || !row.date_ecriture || !row.date_piece || row.date_ecriture < input.periodStart || row.date_piece >= input.periodStart) continue;
    const rows = groups.get(row.piece) ?? [];
    rows.push(row);
    groups.set(row.piece, rows);
  }
  return [...groups.entries()].flatMap(([piece, rows]) => {
    const classification = input.classify(rows);
    if (!classification) return [];
    const amount = rows.reduce((total, row) => total + Number(row.debit ?? 0), 0);
    const firstDate = rows.map((row) => row.date_ecriture as string).sort()[0];
    return [{
      id: piece,
      date: firstDate,
      ...(classification.reversalDate ? { contre_passation_le: classification.reversalDate } : {}),
      montant: mad(amount),
      nature: classification.nature,
    }];
  });
}
