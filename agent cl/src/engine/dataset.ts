import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readCsv } from './csv.js';

export type Row = Record<string, string>;
export type JsonObject = Record<string, unknown>;

export interface BankDataset {
  name: string;
  key: string;
  rows: Row[];
  header: JsonObject;
}

export interface ClosingDataset {
  period: string;
  periodEnd: string;
  ledger: Row[];
  banks: BankDataset[];
  policy: JsonObject;
  fiscal: JsonObject;
  chart: Row[];
  documents: Row[];
  tiers: Row[];
  openingBalance: Row[];
  assets: Row[];
  inventory: Row[];
  societe: JsonObject;
  openItems: Row[];
  priorDeclarations: JsonObject;
}

export async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

async function jsonFile(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, 'utf8')) as JsonObject;
}

function periodEnd(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function previousPeriodEnd(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
}

async function findFile(files: string[], predicate: (name: string) => boolean, label: string): Promise<string> {
  const match = files.find((path) => predicate(basename(path)));
  if (!match) throw new Error(`Fichier dataset introuvable: ${label}`);
  return match;
}

export async function findDatasetFile(datasetDir: string, predicate: (name: string) => boolean, label: string): Promise<string> {
  return findFile(await filesUnder(datasetDir), predicate, label);
}

async function optionalFile(files: string[], predicate: (name: string) => boolean): Promise<string | undefined> {
  return files.find((path) => predicate(basename(path)));
}

function bankNameFromFile(path: string, period: string): string {
  const prefix = 'releve_banque_';
  const suffix = `_${period}`;
  const name = basename(path).replace(/\.csv$/i, '');
  return name.startsWith(prefix) ? name.slice(prefix.length).replace(new RegExp(`${suffix}.*$`), '') : name;
}

function headerForBank(headers: JsonObject, name: string): { key: string; header: JsonObject } {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === `banque_${name.toLowerCase()}`);
  const header = key ? headers[key] : undefined;
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error(`En-tête bancaire introuvable: ${name}`);
  return { key: key as string, header: header as JsonObject };
}

export async function loadClosingDataset(datasetDir: string, period: string): Promise<ClosingDataset> {
  const root = decodeURIComponent(datasetDir);
  const files = await filesUnder(root);
  const end = periodEnd(period);
  const previousEnd = previousPeriodEnd(period);
  const ledgerPath = await findFile(files, (name) => name.startsWith(`grand_livre_${period}_`) && name.endsWith('.csv'), 'grand livre');
  const headersPath = await findFile(files, (name) => name === `entetes_releves_${period}.json`, 'en-têtes bancaires');
  const policyPath = await findFile(files, (name) => name === 'politique_cabinet.json', 'politique cabinet');
  const fiscalPath = await findFile(files, (name) => name === 'parametres_fiscaux.json', 'paramètres fiscaux');
  const chartPath = await findFile(files, (name) => name === 'plan_comptable.csv', 'plan comptable');
  const tiersPath = await findFile(files, (name) => name === 'tiers.csv', 'tiers');
  const documentsPath = await findFile(files, (name) => name === 'index_justificatifs.csv', 'index justificatifs');
  const openingPath = await findFile(files, (name) => name === `balance_ouverture_${previousEnd}.csv`, 'balance ouverture');
  const societePath = await findFile(files, (name) => name === 'societe.json', 'société');
  const bankPaths = files
    .filter((path) => {
      const name = basename(path);
      return name.startsWith('releve_banque_') && name.includes(period) && name.endsWith('.csv');
    })
    .sort((a, b) => basename(a).localeCompare(basename(b)));
  if (bankPaths.length === 0) throw new Error(`Aucun relevé bancaire pour ${period}`);
  const headers = await jsonFile(headersPath);
  const banks = await Promise.all(bankPaths.map(async (path) => {
    const name = bankNameFromFile(path, period);
    const { key, header } = headerForBank(headers, name);
    return { name, key, rows: await readCsv(path), header };
  }));
  const assetsPath = await optionalFile(files, (name) => name === `registre_immobilisations_${previousEnd}.csv`);
  const inventoryPath = await optionalFile(files, (name) => name === `inventaire_${end}.csv`);
  const openItemsPath = await optionalFile(files, (name) => name === `postes_ouverts_${previousEnd}.csv`);
  const priorDeclarationsPath = await optionalFile(files, (name) => name === 'declarations_et_rapprochements_anterieurs.json');

  return {
    period,
    periodEnd: end,
    ledger: await readCsv(ledgerPath),
    banks,
    policy: await jsonFile(policyPath),
    fiscal: await jsonFile(fiscalPath),
    chart: await readCsv(chartPath),
    documents: await readCsv(documentsPath),
    tiers: await readCsv(tiersPath),
    openingBalance: await readCsv(openingPath),
    assets: assetsPath ? await readCsv(assetsPath) : [],
    inventory: inventoryPath ? await readCsv(inventoryPath) : [],
    societe: await jsonFile(societePath),
    openItems: openItemsPath ? await readCsv(openItemsPath) : [],
    priorDeclarations: priorDeclarationsPath ? await jsonFile(priorDeclarationsPath) : {},
  };
}

export function nextMonthEnd(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
}
