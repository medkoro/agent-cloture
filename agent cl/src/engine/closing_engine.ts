import type { Anomaly, Output } from '../contracts/output.js';
import { matchBankEntries, reconcileBank } from './bank.js';
import { calculateAssets } from './assets.js';
import { loadClosingDataset, nextMonthEnd, type ClosingDataset, type Row } from './dataset.js';
import { calculateVat } from './vat.js';

const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const net = (row: Row): number => numberValue(row.debit) - numberValue(row.credit);

function accountBalance(dataset: ClosingDataset, account: string): number {
  const opening = dataset.openingBalance.find((row) => row.compte === account);
  const movements = dataset.ledger.filter((row) => row.compte === account).reduce((total, row) => total + net(row), 0);
  return numberValue(opening?.debit) - numberValue(opening?.credit) + movements;
}

function statementBalance(header: Record<string, unknown>): number {
  const value = header.solde_final_imprime ?? header.solde_final ?? header.balance_finale;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('Solde final bancaire absent ou invalide');
  return parsed;
}

function anomaly(id: string, title: string, description: string, evidence: string[], gravite: string = 'moyenne'): Anomaly {
  return { id, titre: title, description, gravite, preuves: evidence, question: null };
}

function unresolvedBankAnomalies(dataset: ClosingDataset, start: number): Anomaly[] {
  const anomalies: Anomaly[] = [];
  let index = start;
  for (const bank of dataset.banks) {
    const matching = matchBankEntries(bank.rows, dataset.ledger);
    for (const row of bank.rows.filter((candidate) => {
      const id = candidate.id_ligne;
      return id && (candidate.statut_plateforme !== 'comptabilisée' || matching.unmatched.includes(id));
    })) {
      anomalies.push(anomaly(
        `ANO-${String(index++).padStart(3, '0')}`,
        `Mouvement bancaire non rapproché (${bank.name})`,
        `Le mouvement ${row.id_ligne || 'sans identifiant'} porte le statut ${row.statut_plateforme} et ne permet pas de générer une écriture corrective.`,
        [`BQ:${bank.name}:${row.id_ligne || 'inconnu'}`],
      ));
    }
  }
  return anomalies;
}

function missingEvidenceAnomalies(dataset: ClosingDataset, start: number): Anomaly[] {
  const missing = new Map<string, Row>();
  for (const row of dataset.ledger) {
    if (!row.justificatif && row.piece) missing.set(row.piece, row);
  }
  return [...missing.entries()].map(([piece, row], offset) => anomaly(
    `ANO-${String(start + offset).padStart(3, '0')}`,
    'Écriture sans justificatif référencé',
    `La pièce ${piece} ne comporte pas de justificatif dans le grand livre ; aucune écriture complémentaire n’est générée.`,
    [`GL:${piece}`, `GL-LIGNE:${row.ecriture_id || piece}`],
    'haute',
  ));
}

function policyMaximumQuestions(dataset: ClosingDataset): number {
  const questions = dataset.policy.garde_fous as Record<string, unknown> | undefined;
  const client = questions?.questions_client as Record<string, unknown> | undefined;
  const configured = Number(client?.max_par_cloture);
  return Number.isInteger(configured) && configured >= 0 ? configured : 0;
}

function vatAccountTypes(dataset: ClosingDataset): { collected: string[]; charges: string[]; immobilisations: string[] } {
  const normalized = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const collected: string[] = [];
  const charges: string[] = [];
  const immobilisations: string[] = [];
  for (const row of dataset.chart) {
    const label = normalized(row.libelle ?? '');
    if (!label.includes('tva')) continue;
    if (label.includes('facturee') || label.includes('collectee')) collected.push(row.code);
    else if (label.includes('recuperable') && label.includes('immobil')) immobilisations.push(row.code);
    else if (label.includes('recuperable')) charges.push(row.code);
  }
  return { collected, charges, immobilisations };
}

function questionsFor(anomalies: Anomaly[], maximum: number): Output['questions'] {
  return anomalies.slice(0, maximum).map((item) => ({
    id: item.id,
    sujet: item.titre,
    texte: `Merci de fournir la preuve ou la décision nécessaire pour traiter : ${item.titre}.`,
    preuve: item.preuves[0],
  }));
}

export class ClosingEngine {
  constructor(private readonly datasetDir: string, private readonly period: string) {}

  async run(): Promise<Output> {
    const dataset = await loadClosingDataset(this.datasetDir, this.period);
    const bankAnomalies = unresolvedBankAnomalies(dataset, 1);
    const anomalies = [
      ...bankAnomalies,
      ...missingEvidenceAnomalies(dataset, bankAnomalies.length + 1),
    ];
    const tvaConfig = dataset.fiscal.tva as Record<string, unknown> | undefined;
    const tva = calculateVat({
      regime: String(tvaConfig?.regime_dossier ?? 'inconnu'),
      ledger: dataset.ledger,
      periodEnd: dataset.periodEnd,
      dueDate: nextMonthEnd(this.period),
      accountTypes: vatAccountTypes(dataset),
      nonDeductible: Array.isArray(tvaConfig?.non_deductible) ? tvaConfig.non_deductible.filter((value): value is string => typeof value === 'string') : [],
    });
    if (tva.regime.toLowerCase() === 'encaissement') {
      anomalies.push(anomaly(
        `ANO-${String(anomalies.length + 1).padStart(3, '0')}`,
        'TVA à l’encaissement partiellement résolue',
        'Le moteur calcule uniquement les comptes TVA explicitement présents et ne génère pas de déclaration complète sans preuve de lettrage entre encaissements, paiements et pièces.',
        ['GL:comptes_tva', ...dataset.banks.map((bank) => `BQ:${bank.name}`)],
        'haute',
      ));
    }
    const assets = calculateAssets({ rows: dataset.assets, periodEnd: dataset.periodEnd });
    if (assets.assets.length > 0) {
      anomalies.push(anomaly(
        `ANO-${String(anomalies.length + 1).padStart(3, '0')}`,
        'Dotation d’immobilisations à revoir',
        'Une dotation déterministe a été calculée depuis le registre, mais aucune écriture n’est générée sans validation des comptes et des règles applicables.',
        assets.assets.map((asset) => `IMMO:${asset.id ?? 'inconnu'}`),
      ));
    }
    const rapprochements = Object.fromEntries(dataset.banks.map((bank) => {
      const account = bank.header.compte_gl;
      if (typeof account !== 'string' || !account) throw new Error(`Compte GL bancaire absent: ${bank.name}`);
      const glBefore = accountBalance(dataset, account);
      const matching = matchBankEntries(bank.rows, dataset.ledger);
      return [bank.name, reconcileBank({
        statementBalance: statementBalance(bank.header),
        glBefore,
        suspens: bank.rows
          .filter((row) => row.id_ligne && matching.unmatched.includes(row.id_ligne))
          .map((row) => ({ id: row.id_ligne, libelle: row.libelle, debit: row.debit, credit: row.credit })),
      })];
    }));
    for (const [name, reconciliation] of Object.entries(rapprochements)) {
      if (reconciliation.ecart_residuel !== 0) {
        anomalies.push(anomaly(
          `ANO-${String(anomalies.length + 1).padStart(3, '0')}`,
          `Écart de rapprochement bancaire (${name})`,
          'Le solde du relevé et le solde du grand livre ne concordent pas ; aucune correction automatique n’est proposée.',
          [`BQ:${name}`, `GL:compte:${String(dataset.banks.find((bank) => bank.name === name)?.header.compte_gl ?? 'inconnu')}`],
          'haute',
        ));
      }
    }
    return {
      propositions: [],
      anomalies,
      tva,
      rapprochements,
      questions: questionsFor(anomalies, policyMaximumQuestions(dataset)),
      journal_securite: [],
    };
  }
}
