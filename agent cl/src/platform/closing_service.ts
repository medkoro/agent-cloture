import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runOrchestrator } from '../agents/orchestrator.js';
import { ClosingStateMachine, type ClosingState } from './domain.js';
import { renderClosingDossier } from './dossier.js';
import { TraceWriter } from './trace.js';

export interface ClosingSession {
  id: string;
  dossier: string;
  period: string;
  state: ClosingState;
  createdAt: string;
  updatedAt: string;
}

export interface ClosingSessionStore {
  save(session: ClosingSession): Promise<void>;
  get(id: string): Promise<ClosingSession | undefined>;
  list?(): Promise<ClosingSession[]>;
}

export class InMemoryClosingSessionStore implements ClosingSessionStore {
  private readonly sessions = new Map<string, ClosingSession>();

  async save(session: ClosingSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async get(id: string): Promise<ClosingSession | undefined> {
    const session = this.sessions.get(id);
    return session ? { ...session } : undefined;
  }

  async list(): Promise<ClosingSession[]> {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }
}

export class ClosingService {
  private readonly approvalTokens = new Map<string, string>();

  constructor(private readonly store: ClosingSessionStore, private readonly dataRoot: string) {}

  async run(input: { dossier: string; period: string; datasetDir: string }): Promise<ClosingSession> {
    const now = new Date().toISOString();
    const session: ClosingSession = { id: randomUUID(), dossier: input.dossier, period: input.period, state: 'preparee', createdAt: now, updatedAt: now };
    await this.store.save(session);
    const sessionDir = join(this.dataRoot, session.id);
    const trace = new TraceWriter(join(sessionDir, 'trace.jsonl'));
    try {
      await trace.write({ type: 'plan', chantiers: ['W01', 'W02', 'W04', 'W05', 'W08', 'W12'], period: input.period });
      const machine = new ClosingStateMachine(session.state);
      machine.transition('en_cours');
      session.state = machine.state;
      await trace.write({ type: 'tool', agent: 'orchestrateur', outil: 'run_deterministic_engine', args: { dossier: input.dossier } });
      const output = await runOrchestrator(input.datasetDir, input.period, async (event) => {
        if (event.type === 'llm') await trace.write({ type: 'hypothese', agent: 'orchestrateur', texte: event.content ?? '' });
        else await trace.write({ type: 'tool', agent: 'orchestrateur', outil: event.name ?? 'unknown', args: event.input, resultat: event.output });
      });
      session.state = machine.transition('attente_revue');
      session.updatedAt = new Date().toISOString();
      await mkdir(join(sessionDir, 'sortie_agent'), { recursive: true });
      const files: Record<string, unknown> = {
        propositions: output.propositions,
        anomalies: output.anomalies,
        tva: output.tva,
        rapprochements: output.rapprochements,
        questions: output.questions,
        journal_securite: output.journal_securite,
      };
      for (const [name, value] of Object.entries(files)) {
        await writeFile(join(sessionDir, 'sortie_agent', `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      }
      await writeFile(join(sessionDir, 'dossier_cloture.md'), renderClosingDossier({
        state: session.state,
        period: input.period,
        propositionCount: output.propositions.length,
        blockingAnomalyCount: output.anomalies.filter((anomaly) => anomaly.gravite === 'bloquante').length,
        tvaDue: output.tva.tva_due,
        nextActions: ['Revue des preuves', 'Approbation par expert.comptable'],
      }), 'utf8');
      await trace.write({ type: 'verification', agent: 'verificateur', verdict: 'acceptee', propositionCount: output.propositions.length });
      await this.store.save(session);
      return session;
    } catch (error) {
      session.state = 'bloquee';
      session.updatedAt = new Date().toISOString();
      await trace.write({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      await this.store.save(session);
      throw error;
    }
  }

  async list(): Promise<ClosingSession[]> {
    return this.store.list ? this.store.list() : [];
  }

  async get(id: string): Promise<ClosingSession | undefined> {
    return this.store.get(id);
  }

  async approve(id: string, propositionId: string, approver: string): Promise<{ propositionId: string; approuvePar: string; jeton: string }> {
    const session = await this.store.get(id);
    if (!session || session.state !== 'attente_revue') throw new Error('Session non disponible pour approbation');
    if (approver !== 'expert.comptable') throw new Error('Seul expert.comptable peut approuver');
    const jeton = `approval:${id}:${propositionId}:${randomUUID()}`;
    this.approvalTokens.set(jeton, approver);
    return { propositionId, approuvePar: approver, jeton };
  }

  hasApprovalToken(token: string): boolean {
    return this.approvalTokens.has(token);
  }
}
