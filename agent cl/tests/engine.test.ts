import { describe, expect, it } from 'vitest';
import { ClosingEngine } from '../src/engine/closing_engine.js';
import { loadClosingDataset } from '../src/engine/dataset.js';
import { checkLedgerIntegrity } from '../src/engine/integrity.js';
import { detectInternalTransfers, detectTruncations, verifyStatementChecksum, type StatementChecksum } from '../src/engine/bank_engine.js';
import { OutputSchema } from '../src/contracts/output.js';

const dataset = new URL('../../datasets/atlas_negoce/', import.meta.url).pathname.replace(/^\//, '').replace(/\//g, '\\');

describe('ClosingEngine générique', () => {
  it('does not invent entries when source evidence is insufficient', async () => {
    const output = await new ClosingEngine(dataset, '2026-08').run();
    expect(output.propositions).toHaveLength(0);
    expect(OutputSchema.safeParse(output).success).toBe(true);
    expect(JSON.stringify(output)).not.toContain('Atlas Négoce');
    expect(JSON.stringify(output)).not.toContain('P-01');
    expect(output.anomalies.some((item) => item.titre.includes('TVA'))).toBe(true);
  });

  it('derives bank balances from the injected files', async () => {
    const output = await new ClosingEngine(dataset, '2026-08').run();
    expect(Object.keys(output.rapprochements)).toEqual(expect.arrayContaining(['alpha', 'omega']));
    expect(output.rapprochements.alpha.solde_releve).toBe(351616.26);
    expect(output.rapprochements.omega.solde_releve).toBe(246075.19);
    expect(output.rapprochements.alpha.corrections).toEqual([]);
    expect(output.rapprochements.omega.corrections).toEqual([]);
  });
});

describe('dataset dynamique', () => {
  it('charge societe, postes ouverts, déclarations antérieures et clés bancaires canoniques', async () => {
    const ds = await loadClosingDataset(dataset, '2026-08');
    expect(String((ds.societe.derniere_periode_verrouillee as { fin?: unknown } | undefined)?.fin)).toBe('2026-07-31');
    expect(ds.openItems.length).toBeGreaterThan(0);
    expect(ds.priorDeclarations).toHaveProperty('tva_2026-07');
    expect(ds.banks.map((b) => b.key)).toEqual(['banque_alpha', 'banque_omega']);
  });
});

describe('integrite du grand livre', () => {
  const chart = [
    { code: '3421', libelle: 'Clients', nature: 'ACTIF', lettrable: 'oui', compte_parent: '' },
    { code: '34210001', libelle: 'Clients — X', nature: 'ACTIF', lettrable: 'oui', compte_parent: '3421' },
    { code: '4411', libelle: 'Fournisseurs', nature: 'PASSIF', lettrable: 'oui', compte_parent: '' },
    { code: '44110001', libelle: 'Fournisseurs — Y', nature: 'PASSIF', lettrable: 'oui', compte_parent: '4411' },
  ];
  it('detecte ecriture desequilibree, periode verrouillee et compte collectif', () => {
    const ledger = [
      { ecriture_id: 'E1', piece: 'P1', date_ecriture: '2026-08-22', compte: '6133', debit: '850.00', credit: '0' },
      { ecriture_id: 'E2', piece: 'P2', date_ecriture: '2026-07-28', compte: '4411', debit: '100', credit: '0' },
      { ecriture_id: 'E2', piece: 'P2', date_ecriture: '2026-07-28', compte: '6134', debit: '0', credit: '100' },
    ];
    const issues = checkLedgerIntegrity(ledger, chart, '2026-07-31');
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'ecriture_desequilibree', ecriture_id: 'E1', ecart: 850 }),
      expect.objectContaining({ type: 'periode_verrouillee', ecriture_id: 'E2', piece: 'P2' }),
      expect.objectContaining({ type: 'compte_collectif', ecriture_id: 'E2', compte: '4411' }),
    ]));
  });
  it('ne signale rien sur un grand livre propre', () => {
    const ok = [{ ecriture_id: 'E1', piece: 'P1', date_ecriture: '2026-08-01', compte: '6133', debit: '10', credit: '0' },
                { ecriture_id: 'E1', piece: 'P1', date_ecriture: '2026-08-01', compte: '44110001', debit: '0', credit: '10' }];
    expect(checkLedgerIntegrity(ok, chart, '2026-07-31')).toEqual([]);
  });
});

describe('bank_engine', () => {
  it('verifie la coherence des totaux imprimes', () => {
    const header = { solde_initial: 1000, total_debit_imprime: 500, total_credit_imprime: 300, solde_final_imprime: 800 };
    const rows = [{ id_ligne: 'X1', debit: '500.00', credit: '0' }, { id_ligne: 'X2', debit: '0', credit: '300.00' }];
    expect(verifyStatementChecksum(header, rows).coherent).toBe(true);
    const rowsTronques = [{ id_ligne: 'X1', debit: '100.00', credit: '0' }, { id_ligne: 'X2', debit: '0', credit: '300.00' }];
    expect(verifyStatementChecksum(header, rowsTronques).ecart_debit).toBe(400);
  });
  it('identifie la troncature OCR par rapprochement avec la facture du grand livre', () => {
    const checksum = { ecart_debit: 4000, ecart_credit: 0, ecart_solde: 4000 } as StatementChecksum;
    const rows = [{ id_ligne: 'O3', libelle: 'VIR EMIS FOURN TE-5521', debit: '365.12', credit: '0' }];
    const ledger = [
      { piece: 'TE-5521', compte: '6142', debit: '3637.60', credit: '0' },
      { piece: 'TE-5521', compte: '34552', debit: '727.52', credit: '0' },
      { piece: 'TE-5521', compte: '44110012', debit: '0', credit: '4365.12' },
    ];
    const found = detectTruncations({ key: 'banque_omega', rows }, checksum, ledger);
    expect(found).toEqual([{ banque: 'banque_omega', id_ligne: 'O3', piece: 'TE-5521', montant_extrait: 365.12, montant_corrige: 4365.12, ecart: 4000 }]);
  });
  it('detecte les virements internes entre comptes propres', () => {
    const a = { key: 'banque_alpha', rows: [{ id_ligne: 'A13', date_operation: '2026-08-19', libelle: 'VIR EMIS VERS AUTRE COMPTE', debit: '50000.00', credit: '0' }] };
    const b = { key: 'banque_omega', rows: [{ id_ligne: 'O2', date_operation: '2026-08-19', libelle: 'VIR RECU AUTRE COMPTE', debit: '0', credit: '50000.00' }] };
    expect(detectInternalTransfers([a, b])).toEqual([{ montant: 50000, date: '2026-08-19', source: { key: 'banque_alpha', id_ligne: 'A13' }, cible: { key: 'banque_omega', id_ligne: 'O2' } }]);
  });
  it('traite les champs den-tete manquants comme zero', () => {
    const summary = verifyStatementChecksum({}, [{ id_ligne: 'X1', debit: '0', credit: '0' }]);
    expect(summary).toMatchObject({ ecart_debit: 0, ecart_credit: 0, ecart_solde: 0, coherent: true });
  });
  it('scanne le sens credit quand lecart porte sur les credits', () => {
    const checksum = { ecart_debit: 0, ecart_credit: 4000, ecart_solde: 4000 } as StatementChecksum;
    const rows = [{ id_ligne: 'O4', libelle: 'VIR RECU CLIENT TE-5521', debit: '0', credit: '365.12' }];
    const ledger = [
      { piece: 'TE-5521', compte: '6142', debit: '3637.60', credit: '0' },
      { piece: 'TE-5521', compte: '34552', debit: '727.52', credit: '0' },
      { piece: 'TE-5521', compte: '44110012', debit: '0', credit: '4365.12' },
    ];
    const found = detectTruncations({ key: 'banque_omega', rows }, checksum, ledger);
    expect(found).toEqual([{ banque: 'banque_omega', id_ligne: 'O4', piece: 'TE-5521', montant_extrait: 365.12, montant_corrige: 4365.12, ecart: 4000 }]);
  });
  it('detecte des troncatures debit et credit simultanees', () => {
    const checksum = { ecart_debit: 4000, ecart_credit: 1000, ecart_solde: 5000 } as StatementChecksum;
    const rows = [
      { id_ligne: 'O3', libelle: 'VIR EMIS FOURN TE-5521', debit: '365.12', credit: '0' },
      { id_ligne: 'O6', libelle: 'VIR RECU CLIENT TE-5530', debit: '0', credit: '222.00' },
    ];
    const ledger = [
      { piece: 'TE-5521', compte: '44110012', debit: '0', credit: '4365.12' },
      { piece: 'TE-5530', compte: '44110014', debit: '0', credit: '1222.00' },
    ];
    const found = detectTruncations({ key: 'banque_omega', rows }, checksum, ledger);
    expect(found).toEqual([
      { banque: 'banque_omega', id_ligne: 'O3', piece: 'TE-5521', montant_extrait: 365.12, montant_corrige: 4365.12, ecart: 4000 },
      { banque: 'banque_omega', id_ligne: 'O6', piece: 'TE-5530', montant_extrait: 222, montant_corrige: 1222, ecart: 1000 },
    ]);
  });
  it('ignore une incoherence a la centime pres', () => {
    const checksum = { ecart_debit: 4000, ecart_credit: 0, ecart_solde: 4000 } as StatementChecksum;
    const rows = [{ id_ligne: 'O3', libelle: 'VIR EMIS FOURN TE-5521', debit: '365.13', credit: '0' }];
    const ledger = [{ piece: 'TE-5521', compte: '44110012', debit: '0', credit: '4365.12' }];
    expect(detectTruncations({ key: 'banque_omega', rows }, checksum, ledger)).toEqual([]);
  });
  it('ne consomme une ligne que par un seul virement', () => {
    const a = { key: 'banque_alpha', rows: [{ id_ligne: 'A13', date_operation: '2026-08-19', debit: '50000.00', credit: '0' }] };
    const b = { key: 'banque_omega', rows: [
      { id_ligne: 'O2', date_operation: '2026-08-19', debit: '0', credit: '50000.00' },
      { id_ligne: 'O5', date_operation: '2026-08-19', debit: '0', credit: '50000.00' },
    ] };
    const found = detectInternalTransfers([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ source: { key: 'banque_alpha', id_ligne: 'A13' }, cible: { key: 'banque_omega', id_ligne: 'O2' } });
  });
  it('ignore les virements de dates differentes', () => {
    const a = { key: 'banque_alpha', rows: [{ id_ligne: 'A13', date_operation: '2026-08-19', debit: '50000.00', credit: '0' }] };
    const b = { key: 'banque_omega', rows: [{ id_ligne: 'O2', date_operation: '2026-08-20', debit: '0', credit: '50000.00' }] };
    expect(detectInternalTransfers([a, b])).toEqual([]);
  });
});
