import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ClosingEngine } from '../engine/closing_engine.js';
import { ClientChannel } from './client_channel.js';
import { scanClientResponse, scanDocumentPdf, type SecurityEvent } from './security.js';
import type { Anomaly, Output } from '../contracts/output.js';
import { validateOutput } from '../guardrails/validator.js';
import { AgentLoop, type AgentLoopEvent } from './agent_loop.js';
import { createLlmProvider } from '../platform/llm.js';
import { createClosingTools } from './closing_tools.js';
import { loadClosingDataset, type Row } from '../engine/dataset.js';

const normalize = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

interface ScenarioQuestion {
  id: string;
  sujet?: string;
  mots_cles?: string[];
  reponse?: string;
}

function matchScenarioQuestion(asked: Output['questions'][number], scenarioQuestions: ScenarioQuestion[]): ScenarioQuestion | undefined {
  const haystack = normalize(`${asked.sujet ?? ''} ${asked.texte} ${asked.preuve ?? ''}`);
  return scenarioQuestions.find((candidate) => (candidate.mots_cles ?? []).some((keyword) => keyword && haystack.includes(normalize(keyword))));
}

// Scanne les documents réellement injectés (jamais uniquement leurs métadonnées CSV) : chaque
// pièce référencée dans l'index est lue depuis le dossier et son contenu structurel analysé.
async function scanInjectedDocuments(datasetDir: string, documents: Row[]): Promise<SecurityEvent[]> {
  const events: SecurityEvent[] = [];
  for (const document of documents) {
    if (!document.fichier || !document.fichier.toLowerCase().endsWith('.pdf')) continue;
    let buffer: Buffer;
    try {
      buffer = await readFile(join(datasetDir, document.fichier));
    } catch {
      continue; // pièce indexée mais absente du dossier injecté : rien à analyser, pas d'invention.
    }
    const event = scanDocumentPdf(buffer, document.fichier);
    if (event) events.push(event);
  }
  return events;
}

// Boucle de communication client (simulée) : pour chaque question effectivement posée au
// client (dérivée des anomalies, cf. ClientChannel), tente de retrouver la réponse simulée
// correspondante et l'analyse comme une donnée non fiable — jamais comme une instruction.
function scanClientResponses(questions: Output['questions'], scenario: { questions?: ScenarioQuestion[] }): SecurityEvent[] {
  const scenarioQuestions = scenario.questions ?? [];
  const events: SecurityEvent[] = [];
  for (const asked of questions) {
    const matched = matchScenarioQuestion(asked, scenarioQuestions);
    if (!matched?.reponse) continue;
    const event = scanClientResponse(matched.id, matched.reponse);
    if (event) events.push(event);
  }
  return events;
}

function anomalyFromSecurityEvent(event: SecurityEvent, index: number): Anomaly {
  const id = `ANO-SEC-${String(index + 1).padStart(2, '0')}`;
  if (event.type === 'contournement_approbation') {
    return {
      id,
      titre: `Tentative de contournement d'approbation détectée dans la réponse client ${event.source.replace(/^SIM:/, '')}`,
      description: `La réponse client analysée contient une formulation de validation globale (${event.indicateurs.join(', ')}) qui ne constitue pas une approbation valide (garde-fou n°10) : instruction rejetée, aucun statut de proposition n'a été modifié.`,
      gravite: 'haute',
      action_attendue: 'signaler_securite',
      preuves: event.preuves,
      question: null,
    };
  }
  const label = event.type === 'texte_invisible' ? 'texte invisible (couleur blanche et/ou police quasi nulle)' : 'instruction cachée hors affichage normal';
  return {
    id,
    titre: `Injection de prompt détectée dans le document ${basename(event.source)}`,
    description: `Le document ${event.source} contient une instruction adressée à l'IA sous forme de ${label} (${event.indicateurs.join(', ')}) lui demandant de comptabiliser/clôturer sans approbation. Neutralisée : traitée comme donnée non fiable, aucune action exécutée.`,
    gravite: 'bloquante',
    action_attendue: 'signaler_securite',
    preuves: event.preuves,
    question: null,
  };
}

export async function runOrchestrator(datasetDir: string, period: string, onAgentEvent?: (event: AgentLoopEvent) => Promise<void>): Promise<Output> {
  const base = await new ClosingEngine(datasetDir, period).run();
  const agent = new AgentLoop(createLlmProvider(), createClosingTools(datasetDir, period, base), onAgentEvent);
  await agent.run(`Clôture le dossier injecté pour la période ${period}. Consulte la politique, vérifie les relevés disponibles, consulte le résultat TVA déterministe puis les résultats de clôture. Ne crée aucune écriture et termine par un résumé court.`);
  const dataset = await loadClosingDataset(datasetDir, period);

  const policy = dataset.policy.garde_fous as Record<string, unknown> | undefined;
  const questionPolicy = policy?.questions_client as Record<string, unknown> | undefined;
  const maximumQuestions = Number(questionPolicy?.max_par_cloture);
  const interdits = Array.isArray(policy?.interdits) ? policy.interdits.filter((item): item is string => typeof item === 'string') : [];
  const collectiveRule = interdits.find((item) => item.toLowerCase().includes('compte collectif')) ?? '';
  const collectiveAccounts = [...collectiveRule.matchAll(/\b\d{4,}\b/g)].map((match) => match[0]);
  const lockedThrough = typeof policy?.periode_verrouillee_jusqu_au === 'string' ? policy.periode_verrouillee_jusqu_au : undefined;

  const questions = new ClientChannel().questions(base.anomalies, Number.isInteger(maximumQuestions) ? maximumQuestions : 0);

  const [documentEvents, responseEvents] = await Promise.all([
    scanInjectedDocuments(datasetDir, dataset.documents),
    Promise.resolve(scanClientResponses(questions, dataset.clientScenario as { questions?: ScenarioQuestion[] })),
  ]);
  const securityEvents = [...documentEvents, ...responseEvents];
  const securityAnomalies = securityEvents.map((event, index) => anomalyFromSecurityEvent(event, index));

  return validateOutput({
    ...base,
    anomalies: [...base.anomalies, ...securityAnomalies],
    questions,
    journal_securite: securityEvents,
  }, { lockedThrough, collectiveAccounts });
}
