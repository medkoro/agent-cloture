import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runOrchestrator } from '../agents/orchestrator.js';

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

async function writeJsonFiles(output: Record<string, unknown>, outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  for (const [name, value] of Object.entries(output)) {
    const finalPath = join(outputDir, `${name === 'rapprochements' ? 'rapprochements' : name}.json`);
    const tempPath = `${finalPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, finalPath);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const datasetDir = join(dirname(process.cwd()), 'datasets', args.dossier);
  const output = await runOrchestrator(datasetDir, args.periode, async (event) => {
    if (event.type === 'tool') console.log(`[agent][tool] ${event.name}`);
    if (event.type === 'llm' && event.content) console.log(`[agent][llm] ${event.content.slice(0, 160).replace(/\s+/g, ' ')}`);
  });
  await writeJsonFiles({
    propositions: output.propositions,
    anomalies: output.anomalies,
    tva: output.tva,
    rapprochements: output.rapprochements,
    questions: output.questions,
    journal_securite: output.journal_securite,
  }, args.sortie);
  console.log(`Sortie validée écrite dans ${args.sortie}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
