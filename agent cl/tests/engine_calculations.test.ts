import { describe, expect, it } from 'vitest';
import { calculateAssets } from '../src/engine/assets.js';
import { matchBankEntries } from '../src/engine/bank.js';
import { cutoffRules } from '../src/engine/cutoff.js';
import { calculateForex } from '../src/engine/forex.js';

describe('calculs déterministes génériques', () => {
  it('calcule les dotations à partir du registre injecté', () => {
    const result = calculateAssets({
      periodEnd: '2024-01-31',
      rows: [
        { id: 'asset-a', date_acquisition: '2023-01-01', valeur_origine_ht: '12000', taux_pct: '12', dotation_mensuelle: '' },
        { id: 'asset-b', date_acquisition: '2024-02-01', valeur_origine_ht: '5000', taux_pct: '20', dotation_mensuelle: '' },
      ],
    });
    expect(result.monthlyDepreciation).toBe(120);
    expect(result.assets).toHaveLength(1);
  });

  it('calcule les écarts de change à partir des règlements fournis', () => {
    const result = calculateForex({
      realized: [{ id: 'settlement-1', currency: 'EUR', foreignAmount: 100, historicalRate: 10, settlementRate: 10.5 }],
      latent: [{ id: 'open-item-1', currency: 'USD', foreignAmount: 50, historicalRate: 9, closingRate: 9.2 }],
    });
    expect(result.realized[0].amount).toBe(50);
    expect(result.latent[0].amount).toBe(10);
  });

  it('dérive les écritures de cut-off des lignes et du classifieur fourni', () => {
    const result = cutoffRules({
      periodStart: '2024-02-01',
      rows: [
        { piece: 'DOC-1', date_ecriture: '2024-02-02', date_piece: '2024-01-31', debit: '100', credit: '0' },
        { piece: 'DOC-1', date_ecriture: '2024-02-02', date_piece: '2024-01-31', debit: '0', credit: '100' },
      ],
      classify: () => ({ nature: 'FNP', reversalDate: '2024-03-01' }),
    });
    expect(result).toEqual([{ id: 'DOC-1', date: '2024-02-02', contre_passation_le: '2024-03-01', montant: 100, nature: 'FNP' }]);
  });

  it('lettrage les mouvements bancaires par référence source', () => {
    const result = matchBankEntries(
      [{ id_ligne: 'BANK-1' }, { id_ligne: 'BANK-2' }],
      [{ ref_banque: 'BANK-1' }],
    );
    expect(result).toEqual({ matched: ['BANK-1'], unmatched: ['BANK-2'] });
  });
});
