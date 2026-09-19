import { describe, expect, it } from 'vitest';
import { validateOutput } from '../src/guardrails/validator.js';

const valid = {
  propositions: [{
    id: 'P-OK',
    type: 'standard',
    date: '2026-08-31',
    statut: 'proposee',
    preuves: ['GL:test'],
    lignes: [{ compte: '6111', debit: 100, credit: 0 }, { compte: '44110001', debit: 0, credit: 100 }],
  }],
  anomalies: [{ id: 'ANO-OK', titre: 'Contrôle', description: 'Description', preuves: ['GL:test'] }],
  tva: { regime: 'encaissement', credit_anterieur: 0, tva_due: 0, tva_collectee_exigible: 0, tva_deductible_charges: 0, tva_deductible_immobilisations: 0 },
  rapprochements: { banque_alpha: { solde_gl_apres: 0, ecart_residuel: 0 }, banque_omega: { solde_gl_apres: 0, ecart_residuel: 0 } },
  questions: [{ id: 'Q01', texte: 'Quel est le justificatif de la pièce REF 123 du 31/08 pour 100 MAD ?' }],
  journal_securite: [],
};

describe('validateOutput', () => {
  it('accepts a balanced proposed entry with proofs', () => {
    expect(() => validateOutput(valid)).not.toThrow();
  });

  it('rejects an entry with an unequal debit and credit', () => {
    const output = structuredClone(valid);
    output.propositions[0].lignes[0].debit = 101;
    expect(() => validateOutput(output)).toThrow(/déséquilibrée/);
  });

  it('rejects locked dates and root collective accounts', () => {
    const output = structuredClone(valid);
    output.propositions[0].date = '2026-07-31';
    output.propositions[0].lignes[0].compte = '3421';
    expect(() => validateOutput(output, { lockedThrough: '2026-07-31', collectiveAccounts: ['3421'] })).toThrow(/verrouillée|collectif/);
  });

  it('does not apply dossier-specific guardrails when no policy is supplied', () => {
    const output = structuredClone(valid);
    output.propositions[0].date = '2026-07-31';
    output.propositions[0].lignes[0].compte = '3421';
    expect(() => validateOutput(output)).not.toThrow();
  });

  it('rejects posted entries without a human approver or proofs', () => {
    const output = structuredClone(valid);
    output.propositions[0].statut = 'postee';
    output.propositions[0].preuves = [];
    expect(() => validateOutput(output)).toThrow(/approbation|preuve/);
  });

  it('rejects every unbalanced proposition, including complements', () => {
    const output = structuredClone(valid);
    output.propositions[0].type = 'complement';
    output.propositions[0].lignes = [{ compte: '44110013', debit: 0, credit: 850 }];
    expect(() => validateOutput(output)).toThrow(/déséquilibrée/);
  });
});
