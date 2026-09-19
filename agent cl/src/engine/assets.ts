import { mad } from './money.js';

export interface AssetRow {
  id?: string;
  date_acquisition?: string;
  valeur_origine_ht?: string | number;
  taux_pct?: string | number;
  dotation_mensuelle?: string | number;
  cumul_amort_31_07?: string | number;
  remarque?: string;
  [key: string]: string | number | undefined;
}

export interface AssetResult {
  monthlyDepreciation: number;
  assets: AssetRow[];
}

const amount = (value: string | number | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function calculateAssets(input: { rows: AssetRow[]; periodEnd: string }): AssetResult {
  const assets = input.rows.filter((row) => {
    if (!row.date_acquisition || row.date_acquisition > input.periodEnd) return false;
    const origin = amount(row.valeur_origine_ht);
    const cumulativeKey = Object.keys(row).find((key) => key.startsWith('cumul_amort'));
    const cumulative = amount(cumulativeKey ? row[cumulativeKey] : undefined);
    const monthly = amount(row.dotation_mensuelle) || mad((origin * amount(row.taux_pct)) / 100 / 12);
    return origin > cumulative && monthly > 0 && !row.remarque?.toLowerCase().includes('totalement amorti');
  });
  return {
    monthlyDepreciation: mad(assets.reduce((total, row) => {
      const monthly = amount(row.dotation_mensuelle) || (amount(row.valeur_origine_ht) * amount(row.taux_pct)) / 100 / 12;
      return total + monthly;
    }, 0)),
    assets,
  };
}
