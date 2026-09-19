import 'dotenv/config';
import { ClosingEngine } from '../engine/closing_engine.js';
import { ClientChannel } from './client_channel.js';
import { scanUntrustedText } from './security.js';
import type { Output } from '../contracts/output.js';
import { validateOutput } from '../guardrails/validator.js';
import { AgentLoop, type AgentLoopEvent } from './agent_loop.js';
import { createLlmProvider } from '../platform/llm.js';
import { createClosingTools } from './closing_tools.js';
import { loadClosingDataset } from '../engine/dataset.js';

export async function runOrchestrator(datasetDir: string, period: string, onAgentEvent?: (event: AgentLoopEvent) => Promise<void>): Promise<Output> {
  const base = await new ClosingEngine(datasetDir, period).run();
  const agent = new AgentLoop(createLlmProvider(), createClosingTools(datasetDir, period, base), onAgentEvent);
  await agent.run(`Clôture le dossier injecté pour la période ${period}. Consulte la politique, vérifie les relevés disponibles, consulte le résultat TVA déterministe puis les résultats de clôture. Ne crée aucune écriture et termine par un résumé court.`);
  const dataset = await loadClosingDataset(datasetDir, period);
  const security = dataset.documents
    .map((document) => scanUntrustedText(Object.values(document).join(' '), document.fichier || 'document'))
    .filter((event): event is NonNullable<typeof event> => event !== undefined);
  const policy = dataset.policy.garde_fous as Record<string, unknown> | undefined;
  const questionPolicy = policy?.questions_client as Record<string, unknown> | undefined;
  const maximumQuestions = Number(questionPolicy?.max_par_cloture);
  const interdits = Array.isArray(policy?.interdits) ? policy.interdits.filter((item): item is string => typeof item === 'string') : [];
  const collectiveRule = interdits.find((item) => item.toLowerCase().includes('compte collectif')) ?? '';
  const collectiveAccounts = [...collectiveRule.matchAll(/\b\d{4,}\b/g)].map((match) => match[0]);
  const lockedThrough = typeof policy?.periode_verrouillee_jusqu_au === 'string' ? policy.periode_verrouillee_jusqu_au : undefined;
  return validateOutput({
    ...base,
    questions: new ClientChannel().questions(base.anomalies, Number.isInteger(maximumQuestions) ? maximumQuestions : 0),
    journal_securite: security,
  }, { lockedThrough, collectiveAccounts });
}
