import { describe, expect, it } from 'vitest';
import { ClosingEngine } from '../src/engine/closing_engine.js';
import { loadClosingDataset } from '../src/engine/dataset.js';
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
