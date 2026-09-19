import { describe, expect, it } from 'vitest';
import { ClosingEngine } from '../src/engine/closing_engine.js';
import { loadClosingDataset } from '../src/engine/dataset.js';
import { checkLedgerIntegrity } from '../src/engine/integrity.js';
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
