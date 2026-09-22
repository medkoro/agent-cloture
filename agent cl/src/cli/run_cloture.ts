import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runOrchestrator } from '../agents/orchestrator.js';
import { renderClosingDossier } from '../platform/dossier.js';
import { TraceWriter } from '../platform/trace.js';
import type { Output } from '../contracts/output.js';

interface CliArgs {
  dossier: string;
  periode: string;
  sortie: string;
}

function parseArgs(argv: string[]): CliArgs {
  const value = (name: string, fallback?: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback ?? '';
  };
  const dossier = value('dossier');
  const periode = value('periode');
  if (!dossier || !periode) throw new Error('Arguments requis: --dossier <nom> --periode <YYYY-MM>');
  const sortie = value('sortie', join(process.cwd(), 'sortie_agent'));
  if (!/^\d{4}-\d{2}$/.test(periode)) throw new Error(`Période invalide: ${periode}`);
  return { dossier, periode, sortie: resolve(sortie) };
}

function outputFiles(output: Output): Record<string, unknown> {
  return {
    propositions: output.propositions,
    anomalies: output.anomalies,
    tva: output.tva,
    rapprochements: output.rapprochements,
    questions: output.questions,
    journal_securite: output.journal_securite,
  };
}

async function writeJsonFiles(output: Record<string, unknown>, outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  for (const [name, value] of Object.entries(output)) {
    const finalPath = join(outputDir, `${name}.json`);
    const tempPath = `${finalPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, finalPath);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const datasetDir = join(dirname(process.cwd()), 'datasets', args.dossier);
  const sessionId = randomUUID();
  const sessionDir = join(process.cwd(), 'sessions', sessionId);
  const trace = new TraceWriter(join(sessionDir, 'trace.jsonl'));
  await trace.write({ type: 'plan', agent: 'cli', dossier: args.dossier, period: args.periode });

  const output = await runOrchestrator(datasetDir, args.periode, async (event) => {
    if (event.type === 'tool') {
      console.log(`[agent][tool] ${event.name}`);
      await trace.write({ type: 'tool', agent: 'orchestrateur', outil: event.name ?? 'unknown', args: event.input, resultat: event.output });
    }
    if (event.type === 'llm' && event.content) {
      console.log(`[agent][llm] ${event.content.slice(0, 160).replace(/\s+/g, ' ')}`);
      await trace.write({ type: 'hypothese', agent: 'orchestrateur', texte: event.content });
    }
  });

  // Guardrail JSON contract (Phase 0) : validateOutput() a déjà validé `output` dans
  // runOrchestrator avant qu'il ne soit renvoyé ici — aucune proposition n'atteint le disque
  // sans être passée par la porte des garde-fous.
  const files = outputFiles(output);
  await writeJsonFiles(files, args.sortie);

  await mkdir(join(sessionDir, 'sortie_agent'), { recursive: true });
  await writeJsonFiles(files, join(sessionDir, 'sortie_agent'));
  await writeFile(join(sessionDir, 'dossier_cloture.md'), renderClosingDossier({
    state: 'attente_revue',
    period: args.periode,
    propositionCount: output.propositions.length,
    blockingAnomalyCount: output.anomalies.filter((anomaly) => anomaly.gravite === 'bloquante').length,
    tvaDue: output.tva.tva_due,
    nextActions: ['Revue des preuves', 'Approbation par expert.comptable'],
  }), 'utf8');
  await trace.write({ type: 'verification', agent: 'verificateur', verdict: 'acceptee', propositionCount: output.propositions.length });

  console.log(`Sortie validée écrite dans ${args.sortie}`);
  console.log(`Session rejouable : ${sessionDir}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
