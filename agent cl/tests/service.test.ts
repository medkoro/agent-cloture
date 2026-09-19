import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClosingService, InMemoryClosingSessionStore } from '../src/platform/closing_service.js';

const dataset = new URL('../../datasets/atlas_negoce/', import.meta.url).pathname.replace(/^\//, '').replace(/\//g, '\\');

describe('ClosingService', () => {
  it('persists a review-ready session, dossier and replayable trace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-cloture-'));
    const service = new ClosingService(new InMemoryClosingSessionStore(), root);
    const session = await service.run({ dossier: 'atlas_negoce', period: '2026-08', datasetDir: dataset });
    expect(session.state).toBe('attente_revue');
    expect(await readFile(join(root, session.id, 'dossier_cloture.md'), 'utf8')).toContain('TVA due');
    expect((await readFile(join(root, session.id, 'trace.jsonl'), 'utf8')).split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(3);
  });
});
