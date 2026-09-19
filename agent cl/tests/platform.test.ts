import { describe, expect, it } from 'vitest';
import { ClosingStateMachine, type ClosingState } from '../src/platform/domain.js';
import { ToolRegistry } from '../src/platform/tools.js';
import { renderClosingDossier } from '../src/platform/dossier.js';

describe('platform closing workflow', () => {
  it('allows only valid human-in-the-loop state transitions', () => {
    const machine = new ClosingStateMachine('preparee');
    expect(machine.transition('en_cours')).toBe('en_cours');
    expect(machine.transition('attente_revue')).toBe('attente_revue');
    expect(machine.transition('validee')).toBe('validee');
    expect(() => machine.transition('preparee')).toThrow(/Transition/);
  });

  it('blocks guarded posting without a signed approval token', async () => {
    const registry = new ToolRegistry({
      get_policy: async () => ({ approbation_humaine: true }),
      post_approved_entry: async () => ({ posted: true }),
    });
    await expect(registry.call('get_policy', {})).resolves.toEqual({ approbation_humaine: true });
    await expect(registry.call('post_approved_entry', { proposition_id: 'P-01' })).rejects.toThrow(/jeton/);
  });

  it('renders a reviewable dossier with state, numbers and next actions', () => {
    const state: ClosingState = 'attente_revue';
    const dossier = renderClosingDossier({
      state,
      period: '2026-08',
      propositionCount: 38,
      blockingAnomalyCount: 0,
      tvaDue: 5816.51,
      nextActions: ['Approbation par expert.comptable'],
    });
    expect(dossier).toContain('attente_revue');
    expect(dossier).toContain('5 816,51');
    expect(dossier).toContain('Approbation par expert.comptable');
  });
});
