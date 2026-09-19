import { describe, expect, it } from 'vitest';
import { calculateVat } from '../src/engine/vat.js';

describe('calculateVat', () => {
  it('calculates VAT from the supplied ledger rows', () => {
    const result = calculateVat({
      regime: 'encaissement',
      periodEnd: '2024-02-29',
      ledger: [
        { compte: '4455', debit: '0', credit: '1200' },
        { compte: '34552', debit: '300', credit: '0' },
        { compte: '34551', debit: '100', credit: '0' },
      ],
      accountTypes: { collected: ['4455'], charges: ['34552'], immobilisations: ['34551'] },
      creditAnterieur: 50,
      dueDate: '2024-03-31',
    });

    expect(result.tva_collectee_exigible).toBe(1200);
    expect(result.tva_deductible_charges).toBe(300);
    expect(result.tva_deductible_immobilisations).toBe(100);
    expect(result.credit_anterieur).toBe(50);
    expect(result.tva_due).toBe(750);
    expect(result.echeance).toBe('2024-03-31');
  });

  it('excludes deductible VAT explicitly marked non-deductible by fiscal parameters', () => {
    const result = calculateVat({
      regime: 'encaissement',
      ledger: [{ compte: '34552', compte_libelle: 'TVA récupérable sur charges', libelle: 'Carburant véhicule', debit: '100', credit: '0' }],
      accountTypes: { collected: [], charges: ['34552'], immobilisations: [] },
      nonDeductible: ['carburant des véhicules de tourisme'],
    });
    expect(result.tva_deductible_charges).toBe(0);
  });
});
