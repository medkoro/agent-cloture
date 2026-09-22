// RUN3 — propositions comptables restantes (accruals, actifs, paie, change, TVA finale).
// Même discipline que postings.ts / anomalies_run2.ts : rien n'est en dur (comptes, tiers,
// montants, taux) — tout est dérivé des données injectées (grand livre, plan comptable,
// tiers, paramètres fiscaux, politique cabinet, registres actifs/paie/change, index des
// justificatifs, réponses client simulées). Si une donnée manque, la fonction ne propose rien.
import type { EntryLine } from '../contracts/output.js';
import type { AssetRow } from './assets.js';
import type { JsonObject, Row } from './dataset.js';
import { findAccountByLabel } from './postings.js';
import { cents, mad } from './money.js';
import { calculateForex } from './forex.js';

export interface PostingDraft {
  type: string;
  date: string;
  journal: string;
  libelle: string;
  certitude: string;
  preuves: string[];
  lignes: EntryLine[];
  contre_passation_le?: string;
  question_prealable?: string;
}

const amount = (value: string | number | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalized = (value: unknown): string =>
  String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const tokens = (value: unknown, minLength = 4): string[] =>
  normalized(value).split(/[^a-z0-9]+/).filter((token) => token.length >= minLength);

// ── Utilitaires génériques réutilisés par plusieurs propositions ──────────────────────────

/** Extrait le premier montant au format français « 10 000,00 DH/MAD » d'un texte libre. */
export function parseFrenchAmount(text: string): number | undefined {
  const match = String(text ?? '').match(/(\d{1,3}(?:[\s.]\d{3})*(?:,\d{1,2})?)\s*(?:DH|MAD)\b/i);
  if (!match) return undefined;
  const normalized2 = match[1].replace(/[\s.]/g, '').replace(',', '.');
  const parsed = Number(normalized2);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Extrait une date « le JJ/MM/AAAA » d'un texte libre (première occurrence). */
export function parseFrenchDate(text: string): string | undefined {
  const match = String(text ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return undefined;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/** Extrait un ou plusieurs codes de compte (4-8 chiffres) d'une chaîne de convention cabinet. */
export function extractAccountCodes(text: string): string[] {
  return [...String(text ?? '').matchAll(/\b\d{4,8}\b/g)].map((match) => match[0]);
}

/** Extrait un seuil numérique d'une convention cabinet du type « Écart ≤ 50 MAD ... ». */
export function extractThreshold(text: string, pattern: RegExp): number | undefined {
  const match = String(text ?? '').match(pattern);
  return match ? Number(match[1]) : undefined;
}

/** Extrait HT/TVA/TTC d'un texte de facture structuré (« Total HT ... MAD », « TVA X % ... MAD », « Total TTC ... MAD »). */
export function parseInvoiceTotals(text: string): { ht: number; tva: number; ttc: number } | undefined {
  const numberOf = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const parsed = Number(raw.replace(/[\s.]/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const ht = numberOf(text.match(/Total\s+HT\s+([\d\s.,]+?)\s*MAD/i)?.[1]);
  const tva = numberOf(text.match(/TVA\s+\d+(?:[.,]\d+)?\s*%\s+([\d\s.,]+?)\s*MAD/i)?.[1]);
  const ttc = numberOf(text.match(/Total\s+TTC\s+([\d\s.,]+?)\s*MAD/i)?.[1]);
  if (ht === undefined || tva === undefined || ttc === undefined) return undefined;
  return { ht, tva, ttc };
}

/** Recherche un document reçu après la clôture (dossier de réception tardive) pour un fournisseur pas encore saisi ce mois-ci. */
export function findLateSupplierDocument(params: { documents: Row[]; tiers: Row[]; chart: Row[]; ledger: Row[]; periodEnd: string; periodStart: string; folderHint: string }): FnpSource | undefined {
  const doc = params.documents.find((row) => (row.fichier ?? '').includes(params.folderHint) && (row.date ?? '') > params.periodEnd && row.tiers);
  if (!doc) return undefined;
  const tier = params.tiers.find((row) => row.code === doc.tiers);
  if (!tier || String(tier.type ?? '') !== 'fournisseur') return undefined;
  const alreadyRecorded = params.ledger.some((row) => row.tiers === doc.tiers && (row.date_ecriture ?? '') >= params.periodStart);
  if (alreadyRecorded) return undefined;
  const account = resolveAccountFromText(params.chart, String(doc.type ?? ''), { nature: 'CHARGE' });
  if (!account?.code) return undefined;
  const ht = amount(doc.ht);
  const tva = amount(doc.tva);
  if (cents(ht) <= 0) return undefined;
  return { ht: mad(ht), tva: mad(tva), chargeAccount: account.code, proof: `DOC:${doc.fichier}` };
}

/** Résout le compte du plan comptable dont le libellé recoupe le mieux un texte libre (réponse client, document). */
export function resolveAccountFromText(chart: Row[], text: string, opts: { nature?: string; exclude?: string[] } = {}): Row | undefined {
  const words = tokens(text, 5);
  if (words.length === 0) return undefined;
  let best: Row | undefined;
  let bestScore = 0;
  for (const row of chart) {
    if (opts.nature && row.nature !== opts.nature) continue;
    if (opts.exclude?.includes(String(row.code ?? ''))) continue;
    const labelWords = tokens(row.libelle, 5);
    let score = 0;
    for (const word of words) {
      for (const labelWord of labelWords) {
        if (labelWord.includes(word) || word.includes(labelWord)) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return bestScore > 0 ? best : undefined;
}

interface ScenarioQuestion {
  id: string;
  sujet?: string;
  mots_cles?: string[];
  reponse?: string;
  pieces_jointes?: string[];
}

/** Résout le tiers dont le nom recoupe le mieux un texte libre (sujet de question, réponse client). */
export function findTierByAnyToken(tiers: Row[], type: string, text: string): Row | undefined {
  const words = tokens(text, 4);
  if (words.length === 0) return undefined;
  let best: Row | undefined;
  let bestScore = 0;
  for (const tier of tiers) {
    if (String(tier.type ?? '') !== type) continue;
    const nameWords = tokens(tier.nom, 4);
    let score = 0;
    for (const word of words) {
      for (const nameWord of nameWords) {
        if (nameWord === word) score += 2;
        else if (nameWord.includes(word) || word.includes(nameWord)) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = tier;
    }
  }
  return bestScore > 0 ? best : undefined;
}

export function findScenarioAnswer(scenario: JsonObject, keywords: string[]): ScenarioQuestion | undefined {
  const list = (scenario.questions as ScenarioQuestion[] | undefined) ?? [];
  const needles = keywords.map((word) => normalized(word));
  return list.find((question) => (question.mots_cles ?? []).some((keyword) => needles.includes(normalized(keyword))));
}

/** Résout la question du scénario client dont le sujet/mots-clés recoupent le mieux un texte libre (ex. le nom d'un tiers). */
export function findScenarioAnswerByTokenOverlap(scenario: JsonObject, text: string): ScenarioQuestion | undefined {
  const words = tokens(text, 4);
  if (words.length === 0) return undefined;
  const list = (scenario.questions as ScenarioQuestion[] | undefined) ?? [];
  let best: ScenarioQuestion | undefined;
  let bestScore = 0;
  for (const question of list) {
    const haystack = tokens(`${question.sujet ?? ''} ${(question.mots_cles ?? []).join(' ')}`, 4);
    let score = 0;
    for (const word of words) {
      for (const candidate of haystack) {
        if (candidate === word) score += 2;
        else if (candidate.includes(word) || word.includes(candidate)) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = question;
    }
  }
  return bestScore > 0 ? best : undefined;
}

// ── P-05-like : TVA 10 % non extraite sur des frais bancaires déjà comptabilisés TTC ──────
const FEE_PATTERN = /\b(?:frais|commission|tenue|com)\b/i;

export function draftEmbeddedFeeVatCorrection(params: { ledger: Row[]; chart: Row[]; fiscal: JsonObject; periodEnd: string }): PostingDraft | undefined {
  const rate = Number(((params.fiscal.tva as { taux_par_nature?: unknown } | undefined)?.taux_par_nature as Record<string, unknown> | undefined)?.frais_bancaires);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  const feeAccount = findAccountByLabel(params.chart, ['bancaire'], 'CHARGE');
  if (!feeAccount) return undefined;
  const vatAccounts = new Set(params.chart.filter((row) => normalized(row.libelle).includes('tva') && normalized(row.libelle).includes('recuperable') && normalized(row.libelle).includes('charges')).map((row) => row.code));
  const byEcriture = new Map<string, Row[]>();
  for (const row of params.ledger) {
    if (!row.ecriture_id) continue;
    const list = byEcriture.get(row.ecriture_id);
    if (list) list.push(row); else byEcriture.set(row.ecriture_id, [row]);
  }
  let totalTvaCents = 0;
  const preuves: string[] = [];
  for (const [, lines] of byEcriture) {
    const feeLine = lines.find((row) => row.compte === feeAccount && amount(row.debit) > 0 && FEE_PATTERN.test(row.libelle ?? ''));
    if (!feeLine) continue;
    const hasVatLine = lines.some((row) => vatAccounts.has(row.compte ?? ''));
    if (hasVatLine) continue;
    const ttcCents = cents(amount(feeLine.debit));
    const tvaCents = Math.round((ttcCents * rate) / (100 + rate));
    if (tvaCents <= 0) continue;
    totalTvaCents += tvaCents;
    preuves.push(`GL:${feeLine.ecriture_id}`);
  }
  if (totalTvaCents === 0) return undefined;
  const tvaAccount = [...vatAccounts][0];
  if (!tvaAccount) return undefined;
  const tva = mad(totalTvaCents / 100);
  return {
    type: 'standard',
    date: params.periodEnd,
    journal: 'OD',
    libelle: `TVA ${rate} % sur frais bancaires comptabilisés TTC`,
    certitude: 'certaine',
    preuves: preuves.length ? preuves : [`GL:${feeAccount}`],
    lignes: [
      { compte: tvaAccount, debit: tva, credit: 0 },
      { compte: feeAccount, debit: 0, credit: tva },
    ],
  };
}

// ── P-09-like : résoudre un compte transitoire non identifié après réponse client ─────────
export function draftSuspenseResolution(params: {
  ledger: Row[];
  chart: Row[];
  scenario: JsonObject;
  periodEnd: string;
}): { draft: PostingDraft; question: ScenarioQuestion } | undefined {
  const suspenseAccount = findAccountByLabel(params.chart, ['transitoires', 'attente'], 'PASSIF');
  if (!suspenseAccount) return undefined;
  const row = params.ledger.find((candidate) => candidate.compte === suspenseAccount && amount(candidate.credit) > 0 && !candidate.tiers);
  if (!row) return undefined;
  const numericRefs = [...(row.libelle ?? '').matchAll(/\d{4,}/g)].map((match) => match[0]);
  const montant = mad(amount(row.credit));
  const keywords = [...numericRefs, String(montant), String(Math.round(montant))];
  const question = findScenarioAnswer(params.scenario, keywords);
  if (!question?.reponse) return undefined;
  const target = resolveAccountFromText(params.chart, question.reponse, { exclude: [suspenseAccount] });
  if (!target) return undefined;
  return {
    draft: {
      type: 'standard',
      date: row.date_ecriture ?? params.periodEnd,
      journal: 'OD',
      libelle: `Régularisation du compte d'attente (${row.libelle ?? row.piece})`,
      certitude: 'certaine',
      question_prealable: question.id,
      preuves: [`GL:${row.piece || row.ecriture_id}`, `SIM:${question.id}`],
      lignes: [
        { compte: suspenseAccount, debit: montant, credit: 0 },
        { compte: target.code ?? '', debit: 0, credit: montant },
      ],
    },
    question,
  };
}

// ── P-10-like : apport en espèces du dirigeant constaté via pièce jointe client ────────────
export async function draftCashContribution(params: {
  datasetDir: string;
  chart: Row[];
  scenario: JsonObject;
  caisseCompte: string;
  triggerKeywords: string[];
  readAttachment: (path: string) => Promise<string | undefined>;
}): Promise<{ draft: PostingDraft; question: ScenarioQuestion } | undefined> {
  const question = findScenarioAnswer(params.scenario, params.triggerKeywords);
  if (!question?.reponse) return undefined;
  let text = question.reponse;
  for (const attachment of question.pieces_jointes ?? []) {
    const content = await params.readAttachment(attachment);
    if (content) text = `${text} ${content}`;
  }
  const montant = parseFrenchAmount(text);
  if (montant === undefined) return undefined;
  const date = parseFrenchDate(text);
  if (!date) return undefined;
  const target = resolveAccountFromText(params.chart, text, { nature: 'PASSIF' });
  if (!target) return undefined;
  return {
    draft: {
      type: 'standard',
      date,
      journal: 'OD',
      libelle: 'Apport en espèces du dirigeant en compte courant',
      certitude: 'certaine',
      question_prealable: question.id,
      preuves: [`SIM:${question.id}`],
      lignes: [
        { compte: params.caisseCompte, debit: mad(montant), credit: 0 },
        { compte: target.code ?? '', debit: 0, credit: mad(montant) },
      ],
    },
    question,
  };
}

// ── P-11-like : TVA non déductible sur règlement espèces au-delà du plafond ────────────────
export function draftCashThresholdNonDeductible(params: {
  ledger: Row[];
  chart: Row[];
  fiscal: JsonObject;
  caisseCompte: string;
  periodEnd: string;
}): PostingDraft[] {
  const plafondRaw = ((params.fiscal.tva as { reglement_especes?: unknown } | undefined)?.reglement_especes as Record<string, unknown> | undefined)?.plafond_deductible_par_jour_et_fournisseur;
  const plafond = Number(plafondRaw);
  if (!Number.isFinite(plafond)) return [];
  const vatChargeAccount = findAccountByLabel(params.chart, ['tva', 'recuperable', 'charges'], 'ACTIF');
  if (!vatChargeAccount) return [];
  const byPiece = new Map<string, Row[]>();
  for (const row of params.ledger) {
    if (!row.piece) continue;
    const list = byPiece.get(row.piece);
    if (list) list.push(row); else byPiece.set(row.piece, [row]);
  }
  const drafts: PostingDraft[] = [];
  for (const [piece, lines] of byPiece) {
    const cashSettlement = lines.find((row) => row.compte === params.caisseCompte && amount(row.credit) > 0);
    if (!cashSettlement) continue;
    const paid = amount(cashSettlement.credit);
    if (cents(paid) <= cents(plafond)) continue;
    const invoiceLines = params.ledger.filter((row) => row.piece === piece && row.compte !== params.caisseCompte);
    const vatLine = invoiceLines.find((row) => row.compte === vatChargeAccount && amount(row.debit) > 0);
    const chargeLine = invoiceLines.find((row) => row.compte !== vatChargeAccount && amount(row.debit) > 0);
    if (!vatLine || !chargeLine) continue;
    const ttc = invoiceLines.reduce((total, row) => total + amount(row.credit), 0) || paid;
    const tva = amount(vatLine.debit);
    const deductible = mad((tva * Math.min(paid, plafond)) / ttc);
    const nonDeductible = mad(tva - deductible);
    if (cents(nonDeductible) <= 0) continue;
    drafts.push({
      type: 'standard',
      date: params.periodEnd,
      journal: 'OD',
      libelle: `TVA non déductible — règlement espèces ${piece} au-delà de ${plafond} MAD`,
      certitude: 'certaine',
      preuves: [`GL:${piece}`],
      lignes: [
        { compte: chargeLine.compte ?? '', debit: nonDeductible, credit: 0 },
        { compte: vatChargeAccount, debit: 0, credit: nonDeductible },
      ],
    });
  }
  return drafts;
}

// ── P-12-like : écart de règlement client ≤ seuil → frais bancaires ────────────────────────
export function draftSettlementGapFees(params: {
  ledger: Row[];
  chart: Row[];
  policy: JsonObject;
  fiscal: JsonObject;
}): PostingDraft[] {
  const ecartText = String(((params.policy.conventions_comptables as { ecart_reglement?: unknown } | undefined)?.ecart_reglement) ?? '');
  const threshold = extractThreshold(ecartText, /≤\s*(\d+)/);
  if (threshold === undefined) return [];
  const feeAccount = findAccountByLabel(params.chart, ['bancaire'], 'CHARGE');
  const vatChargeAccount = findAccountByLabel(params.chart, ['tva', 'recuperable', 'charges'], 'ACTIF');
  const feesRate = Number(((params.fiscal.tva as { taux_par_nature?: unknown } | undefined)?.taux_par_nature as Record<string, unknown> | undefined)?.frais_bancaires);
  if (!feeAccount || !vatChargeAccount || !Number.isFinite(feesRate)) return [];
  const clientAccounts = new Set(params.chart.filter((row) => row.compte_parent && normalized(row.libelle).includes('client')).map((row) => row.code));

  const invoiceTotals = new Map<string, { piece: string; compte: string; ttc: number }>();
  for (const row of params.ledger) {
    if (!row.piece || !row.compte || !clientAccounts.has(row.compte)) continue;
    if (amount(row.debit) <= 0) continue;
    const existing = invoiceTotals.get(row.piece);
    invoiceTotals.set(row.piece, { piece: row.piece, compte: row.compte, ttc: (existing?.ttc ?? 0) + amount(row.debit) });
  }
  const drafts: PostingDraft[] = [];
  for (const row of params.ledger) {
    if (!row.compte || !clientAccounts.has(row.compte)) continue;
    if (amount(row.credit) <= 0 || row.ref_banque) continue;
    // settlements matched via bank reconciliation already excluded; here we look at direct GL credit lines carrying ref_banque separately below.
  }
  for (const row of params.ledger) {
    if (!row.compte || !clientAccounts.has(row.compte)) continue;
    if (amount(row.credit) <= 0) continue;
    const invoice = [...invoiceTotals.values()].find((candidate) => candidate.compte === row.compte);
    if (!invoice) continue;
    const paid = amount(row.credit);
    const gapCents = cents(invoice.ttc) - cents(paid);
    if (gapCents <= 0 || gapCents > cents(threshold)) continue;
    const gap = mad(gapCents / 100);
    const ht = mad((gapCents * 100) / (100 + feesRate) / 100);
    const tva = mad(gap - ht);
    drafts.push({
      type: 'standard',
      date: row.date_ecriture ?? '',
      journal: 'OD',
      libelle: `Écart de règlement ${invoice.piece} (frais bancaires émetteur)`,
      certitude: 'certaine',
      preuves: [`GL:${invoice.piece}`],
      lignes: [
        { compte: feeAccount, debit: ht, credit: 0 },
        { compte: vatChargeAccount, debit: tva, credit: 0 },
        { compte: row.compte, tiers: row.tiers || undefined, debit: 0, credit: gap },
      ],
    });
  }
  return drafts;
}

// ── P-13/P-14-like : pertes de change réalisées au règlement ───────────────────────────────
const COURS_PATTERN = /COURS\s+([\d,]+)/i;

export function draftRealizedForexLosses(params: { ledger: Row[]; chart: Row[]; banks: { key: string; name: string; rows: Row[] }[] }): PostingDraft[] {
  const natureByCode = new Map(params.chart.map((row) => [String(row.code ?? ''), String(row.nature ?? '')]));
  const drafts: PostingDraft[] = [];
  const lossAccount = findAccountByLabel(params.chart, ['pertes', 'change'], 'CHARGE');
  if (!lossAccount) return [];
  for (const bank of params.banks) {
    for (const row of bank.rows) {
      const coursMatch = (row.libelle ?? '').match(COURS_PATTERN);
      if (!coursMatch) continue;
      const settlementRate = Number(coursMatch[1].replace(',', '.'));
      if (!Number.isFinite(settlementRate)) continue;
      const idLigne = row.id_ligne ?? '';
      const bankRef = `${bank.name.toUpperCase()}:${idLigne}`.toUpperCase();
      const glLine = params.ledger.find((candidate) => (candidate.ref_banque ?? '').toUpperCase() === bankRef && candidate.tiers);
      if (!glLine || !glLine.compte || !glLine.tiers) continue;
      const nature = natureByCode.get(glLine.compte);
      if (nature !== 'ACTIF' && nature !== 'PASSIF') continue;
      const actualMad = amount(row.debit) > 0 ? amount(row.debit) : amount(row.credit);
      const settledForeign = mad(actualMad / settlementRate);
      const invoiceLine = params.ledger.find((candidate) =>
        candidate.compte === glLine.compte && candidate.tiers === glLine.tiers &&
        candidate.taux_change && Number(candidate.taux_change) > 0 && candidate !== glLine);
      if (!invoiceLine) continue;
      const historicalRate = Number(invoiceLine.taux_change);
      const historicalMad = mad(settledForeign * historicalRate);
      const loss = nature === 'ACTIF' ? mad(historicalMad - actualMad) : mad(actualMad - historicalMad);
      if (cents(loss) <= 0) continue;
      drafts.push({
        type: 'standard',
        date: row.date_operation ?? '',
        journal: 'OD',
        libelle: `Perte de change réalisée ${glLine.tiers} (${historicalRate} → ${settlementRate})`,
        certitude: 'certaine',
        preuves: [`GL:${invoiceLine.piece}`, `BQ:${bank.key}:${idLigne}`],
        lignes: [
          { compte: lossAccount, debit: loss, credit: 0 },
          { compte: glLine.compte, tiers: glLine.tiers, debit: 0, credit: loss },
        ],
      });
    }
  }
  return drafts;
}

// ── P-15-like : facture de vente émise mais absente du grand livre (rupture de séquence) ──
export function draftMissingSalesInvoice(params: { documents: Row[]; ledger: Row[]; tiers: Row[]; chart: Row[] }): PostingDraft | undefined {
  const soldeCollectifs = new Set(params.chart.filter((row) => row.compte_parent && normalized(row.libelle).includes('client')).map((row) => row.code));
  const vatAccount = findAccountByLabel(params.chart, ['tva', 'facturee'], 'PASSIF');
  if (!vatAccount) return undefined;
  const tierByCode = new Map(params.tiers.map((row) => [String(row.code ?? ''), row]));
  const recordedPieces = new Set(params.ledger.map((row) => row.piece));
  for (const document of params.documents) {
    if (document.type !== 'FACTURE') continue;
    if (!(document.fichier ?? '').includes('FAC_VENTE')) continue;
    const pieceMatch = (document.fichier ?? '').match(/FAC-\d{4}-\d{3,5}/);
    const piece = pieceMatch?.[0];
    if (!piece || recordedPieces.has(piece)) continue;
    const tier = tierByCode.get(document.tiers ?? '');
    if (!tier?.compte || !soldeCollectifs.has(tier.compte)) continue;
    const ht = amount(document.ht);
    const tva = amount(document.tva);
    const ttc = amount(document.ttc_ou_montant);
    if (cents(ht) <= 0) continue;
    const produitCounts = new Map<string, number>();
    for (const row of params.ledger) {
      if (!row.piece?.startsWith('FAC-') || amount(row.credit) <= 0) continue;
      const nature = params.chart.find((c) => c.code === row.compte)?.nature;
      if (nature !== 'PRODUIT' || normalized(row.compte_libelle).includes('etranger')) continue;
      produitCounts.set(row.compte ?? '', (produitCounts.get(row.compte ?? '') ?? 0) + 1);
    }
    const produitAccount = [...produitCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!produitAccount) continue;
    return {
      type: 'standard',
      date: document.date ?? '',
      journal: 'VTE',
      libelle: `Facture client ${piece} ${tier.nom} non comptabilisée`,
      certitude: 'certaine',
      preuves: [`DOC:${document.fichier}`],
      lignes: [
        { compte: tier.compte, tiers: tier.code, debit: mad(ttc || ht + tva), credit: 0 },
        { compte: produitAccount, debit: 0, credit: mad(ht) },
        { compte: vatAccount, debit: 0, credit: mad(tva) },
      ],
    };
  }
  return undefined;
}

// ── P-16-like : contre-passer une FNP antérieure non reprise, doublonnée par la vraie facture ──
export interface FnpReversalResult {
  draft: PostingDraft;
  supplierTierCode?: string;
  chargeAccount: string;
}

export function draftFnpReversal(params: { ledger: Row[]; chart: Row[]; openingBalance: Row[]; policy: JsonObject; periodStart: string; lockedFin: string }): FnpReversalResult | undefined {
  const fnpText = String(((params.policy.conventions_comptables as { fnp?: unknown } | undefined)?.fnp) ?? '');
  const codes = extractAccountCodes(fnpText);
  if (codes.length < 2) return undefined;
  const [vatFnpAccount, fnpAccount] = codes;
  const opening = params.openingBalance.find((row) => row.compte === fnpAccount);
  const openingCredit = amount(opening?.credit);
  if (cents(openingCredit) <= 0) return undefined;
  const candidate = params.ledger.find((row) => {
    if (!row.piece || !row.date_piece || row.date_piece > params.lockedFin) return false;
    if (!row.date_ecriture || row.date_ecriture < params.periodStart) return false;
    const total = params.ledger.filter((line) => line.piece === row.piece && amount(line.credit) > 0).reduce((sum, line) => sum + amount(line.credit), 0);
    return cents(total) === cents(openingCredit);
  });
  if (!candidate) return undefined;
  const chargeLine = params.ledger.find((row) => row.piece === candidate.piece && amount(row.debit) > 0 && row.compte !== vatFnpAccount);
  const vatLine = params.ledger.find((row) => row.piece === candidate.piece && amount(row.debit) > 0 && row.compte === vatFnpAccount);
  const supplierLine = params.ledger.find((row) => row.piece === candidate.piece && row.tiers);
  if (!chargeLine) return undefined;
  const ht = amount(chargeLine.debit);
  const tva = vatLine ? amount(vatLine.debit) : mad(openingCredit - ht);
  return {
    supplierTierCode: supplierLine?.tiers,
    chargeAccount: chargeLine.compte ?? '',
    draft: {
      type: 'standard',
      date: params.periodStart,
      journal: 'OD',
      libelle: `Contre-passation FNP antérieure non reprise (${candidate.piece})`,
      certitude: 'certaine',
      preuves: [`GL:${fnpAccount}`, `GL:${candidate.piece}`],
      lignes: [
        { compte: fnpAccount, debit: mad(openingCredit), credit: 0 },
        { compte: chargeLine.compte ?? '', debit: 0, credit: mad(ht) },
        { compte: vatFnpAccount, debit: 0, credit: mad(tva) },
      ],
    },
  };
}

// ── P-17/P-18-like : charge constatée d'avance non parvenue (FNP) reconstituée depuis une pièce ──
export interface FnpSource {
  ht: number;
  tva: number;
  chargeAccount: string;
  proof: string;
}

export function draftFnpAccrual(params: { source: FnpSource; policy: JsonObject; periodEnd: string; nextMonthStart: string; libelle: string }): PostingDraft | undefined {
  const fnpText = String(((params.policy.conventions_comptables as { fnp?: unknown } | undefined)?.fnp) ?? '');
  const codes = extractAccountCodes(fnpText);
  if (codes.length < 2) return undefined;
  const [vatFnpAccount, fnpAccount] = codes;
  const ttc = mad(params.source.ht + params.source.tva);
  return {
    type: 'standard',
    date: params.periodEnd,
    journal: 'OD',
    libelle: params.libelle,
    certitude: 'certaine',
    contre_passation_le: params.nextMonthStart,
    preuves: [params.source.proof],
    lignes: [
      { compte: params.source.chargeAccount, debit: mad(params.source.ht), credit: 0 },
      { compte: vatFnpAccount, debit: mad(params.source.tva), credit: 0 },
      { compte: fnpAccount, debit: 0, credit: ttc },
    ],
  };
}

// ── P-19-like : produit à établir (FAE) depuis un PV de réception + devis accepté ──────────
export function draftFaeAccrual(params: { documents: Row[]; chart: Row[]; policy: JsonObject; periodEnd: string; nextMonthStart: string }): PostingDraft | undefined {
  const faeText = String(((params.policy.conventions_comptables as { fae?: unknown } | undefined)?.fae) ?? '');
  const codes = extractAccountCodes(faeText);
  if (codes.length < 2) return undefined;
  const [faeAssetAccount, vatFaeAccount] = codes;
  const pv = params.documents.find((row) => normalized(row.type).includes('reception') && row.tiers);
  if (!pv) return undefined;
  const devis = params.documents.find((row) => row.tiers === pv.tiers && normalized(row.statut_plateforme).includes('accepte'));
  if (!devis) return undefined;
  const ht = amount(devis.ht);
  const tva = amount(devis.tva);
  if (cents(ht) <= 0) return undefined;
  const produitAccount = findAccountByLabel(params.chart, ['services'], 'PRODUIT');
  if (!produitAccount) return undefined;
  return {
    type: 'standard',
    date: params.periodEnd,
    journal: 'OD',
    libelle: `Produit à établir — travaux réceptionnés non facturés (${pv.fichier?.split('/').pop() ?? ''})`,
    certitude: 'certaine',
    contre_passation_le: params.nextMonthStart,
    preuves: [`DOC:${pv.fichier}`, `DOC:${devis.fichier}`],
    lignes: [
      { compte: faeAssetAccount, debit: mad(ht + tva), credit: 0 },
      { compte: produitAccount, debit: 0, credit: mad(ht) },
      { compte: vatFaeAccount, debit: 0, credit: mad(tva) },
    ],
  };
}

// ── Découpage de durée exprimée dans une remarque tiers (annuel/semestriel/trimestriel) ────
const DURATION_KEYWORDS: Array<[RegExp, number]> = [
  [/trimestriel/i, 3],
  [/semestriel/i, 6],
  [/annuel/i, 12],
];

function durationFromRemark(remark: string | undefined): number | undefined {
  for (const [pattern, months] of DURATION_KEYWORDS) {
    if (pattern.test(remark ?? '')) return months;
  }
  return undefined;
}

// ── P-20-like : produit constaté d'avance quand la période de service est postérieure ──────
export function draftPcaDeferral(params: { ledger: Row[]; tiers: Row[]; chart: Row[]; periodEnd: string }): PostingDraft | undefined {
  const pcaAccount = findAccountByLabel(params.chart, ['produits', 'constates', 'avance'], 'PASSIF');
  if (!pcaAccount) return undefined;
  const byPiece = new Map<string, Row[]>();
  for (const row of params.ledger) {
    if (!row.piece) continue;
    const list = byPiece.get(row.piece);
    if (list) list.push(row); else byPiece.set(row.piece, [row]);
  }
  for (const [piece, lines] of byPiece) {
    const tiersCode = lines.find((row) => row.tiers)?.tiers;
    if (!tiersCode) continue;
    const tier = params.tiers.find((candidate) => candidate.code === tiersCode);
    const duration = durationFromRemark(tier?.remarques);
    if (!duration) continue;
    const produitLine = lines.find((row) => amount(row.credit) > 0 && params.chart.find((c) => c.code === row.compte)?.nature === 'PRODUIT');
    if (!produitLine) continue;
    const monthTokens = [...normalized(produitLine.libelle).matchAll(/([a-z]{3,9})\.?\s*(20\d{2})/g)];
    if (monthTokens.length === 0) continue;
    const firstMonth = monthTokens[0];
    const monthIndex = frenchMonthIndex(firstMonth[1]);
    if (monthIndex === undefined) continue;
    const startPeriod = `${firstMonth[2]}-${String(monthIndex).padStart(2, '0')}`;
    if (startPeriod <= params.periodEnd.slice(0, 7)) continue;
    const montant = mad(amount(produitLine.credit));
    return {
      type: 'standard',
      date: params.periodEnd,
      journal: 'OD',
      libelle: `Produit constaté d'avance ${tier?.nom ?? tiersCode} (service à compter de ${startPeriod})`,
      certitude: 'certaine',
      preuves: [`GL:${piece}`],
      lignes: [
        { compte: produitLine.compte ?? '', debit: montant, credit: 0 },
        { compte: pcaAccount, debit: 0, credit: montant },
      ],
    };
  }
  return undefined;
}

function frenchMonthIndex(token: string): number | undefined {
  const map: Record<string, number> = {
    jan: 1, janv: 1, fev: 2, fevr: 2, mar: 3, mars: 3, avr: 4, mai: 5,
    juin: 6, juil: 7, aou: 8, aout: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };
  for (const [prefix, index] of Object.entries(map)) {
    if (token.startsWith(prefix)) return index;
  }
  return undefined;
}

// ── P-21-like : charge constatée d'avance sur un abonnement pluriannuel passé en charge ────
export function draftCcaDeferral(params: { ledger: Row[]; tiers: Row[]; chart: Row[]; periodEnd: string }): PostingDraft | undefined {
  const ccaAccount = findAccountByLabel(params.chart, ['charges', 'constatees', 'avance'], 'ACTIF');
  if (!ccaAccount) return undefined;
  const byPiece = new Map<string, Row[]>();
  for (const row of params.ledger) {
    if (!row.piece) continue;
    const list = byPiece.get(row.piece);
    if (list) list.push(row); else byPiece.set(row.piece, [row]);
  }
  for (const [piece, lines] of byPiece) {
    const tiersCode = lines.find((row) => row.tiers)?.tiers;
    if (!tiersCode) continue;
    const tier = params.tiers.find((candidate) => candidate.code === tiersCode);
    const duration = durationFromRemark(tier?.remarques);
    if (!duration || duration <= 1) continue;
    const chargeLine = lines.find((row) => {
      const nature = params.chart.find((c) => c.code === row.compte)?.nature;
      return nature === 'CHARGE' && amount(row.debit) > 0;
    });
    if (!chargeLine) continue;
    const ht = amount(chargeLine.debit);
    const deferred = mad((ht * (duration - 1)) / duration);
    if (cents(deferred) <= 0) continue;
    return {
      type: 'standard',
      date: params.periodEnd,
      journal: 'OD',
      libelle: `Charge constatée d'avance ${tier?.nom ?? tiersCode} (${duration - 1}/${duration})`,
      certitude: 'certaine',
      preuves: [`GL:${piece}`],
      lignes: [
        { compte: ccaAccount, debit: deferred, credit: 0 },
        { compte: chargeLine.compte ?? '', debit: 0, credit: deferred },
      ],
    };
  }
  return undefined;
}

// ── P-22-like : reprise mensuelle d'une charge constatée d'avance récurrente oubliée ───────
export function draftRecurringCcaRecognition(params: { ledger: Row[]; history: Row[]; openingBalance: Row[]; chart: Row[]; periodEnd: string; lockedFin: string }): PostingDraft | undefined {
  const ccaAccount = findAccountByLabel(params.chart, ['charges', 'constatees', 'avance'], 'ACTIF');
  if (!ccaAccount) return undefined;
  const openingCca = amount(params.openingBalance.find((row) => row.compte === ccaAccount)?.debit);
  if (cents(openingCca) <= 0) return undefined;
  const byAccount = new Map<string, number[]>();
  for (const row of params.history) {
    if (!row.compte) continue;
    const list = byAccount.get(row.compte);
    const value = amount(row.solde_debiteur_positif);
    if (list) list.push(value); else byAccount.set(row.compte, [value]);
  }
  const movedAccounts = new Set(
    params.ledger
      .filter((row) => (row.date_ecriture ?? '') > params.lockedFin && (amount(row.debit) > 0 || amount(row.credit) > 0))
      .map((row) => row.compte),
  );
  for (const [compte, values] of byAccount) {
    if (values.length < 3 || movedAccounts.has(compte)) continue;
    const nature = params.chart.find((c) => c.code === compte)?.nature;
    if (nature !== 'CHARGE') continue;
    const allEqual = values.every((value) => cents(value) === cents(values[0]));
    if (!allEqual || cents(values[0]) <= 0) continue;
    // Le compte doit être celui qui « consomme » exactement le solde ouvert de charges
    // constatées d'avance (un nombre entier de mensualités restant à reprendre), pour ne pas
    // confondre une charge récurrente non liée à une CCA (ex. paie) avec celle réellement visée.
    const monthsRemaining = openingCca / values[0];
    if (!Number.isInteger(Math.round(monthsRemaining * 100) / 100) || monthsRemaining <= 0 || monthsRemaining > 24) continue;
    if (cents(values[0] * Math.round(monthsRemaining)) !== cents(openingCca)) continue;
    const montant = mad(values[0]);
    return {
      type: 'standard',
      date: params.periodEnd,
      journal: 'OD',
      libelle: `Reprise mensuelle charge constatée d'avance (${compte})`,
      certitude: 'certaine',
      preuves: [`OUVERTURE:${ccaAccount}`, `HISTO:${compte}`],
      lignes: [
        { compte, debit: montant, credit: 0 },
        { compte: ccaAccount, debit: 0, credit: montant },
      ],
    };
  }
  return undefined;
}

// ── P-23-like : intérêts courus sur emprunt depuis la dernière échéance ────────────────────
export interface LoanScheduleRow {
  date?: string;
  echeance?: string;
  interets?: string;
  capital?: string;
  capital_restant_du?: string;
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

export function draftAccruedInterest(params: { schedule: LoanScheduleRow[]; chart: Row[]; policy: JsonObject; periodEnd: string; loanRef: string }): PostingDraft | undefined {
  const text = String(((params.policy.conventions_comptables as { interets_courus?: unknown } | undefined)?.interets_courus) ?? '');
  const threshold = extractThreshold(text, />\s*(\d[\d\s]*)\s*MAD/);
  if (threshold === undefined) return undefined;
  const rows = params.schedule.filter((row) => row.date && row.date <= params.periodEnd).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  if (!last || !previous) return undefined;
  const capitalAfter = Number(last.capital_restant_du);
  const monthlyRate = Number(last.interets) / Number(previous.capital_restant_du);
  if (!Number.isFinite(capitalAfter) || !Number.isFinite(monthlyRate)) return undefined;
  const annualRate = monthlyRate * 12;
  const days = daysBetween(String(last.date), params.periodEnd);
  const accrued = mad((capitalAfter * annualRate * days) / 360);
  if (cents(Math.abs(threshold * 100)) > 0 && accrued <= threshold) return undefined;
  const interestAccount = findAccountByLabel(params.chart, ['interets', 'emprunts'], 'CHARGE');
  const accruedAccount = findAccountByLabel(params.chart, ['interets', 'courus'], 'PASSIF');
  if (!interestAccount || !accruedAccount) return undefined;
  const [year, month, day] = params.periodEnd.split('-').map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  const nextMonthStart = next.toISOString().slice(0, 10);
  return {
    type: 'standard',
    date: params.periodEnd,
    journal: 'OD',
    libelle: `Intérêts courus prêt ${params.loanRef} du ${last.date} au ${params.periodEnd}`,
    certitude: 'certaine',
    contre_passation_le: nextMonthStart,
    preuves: [`ECHEANCIER:${params.loanRef}`],
    lignes: [
      { compte: interestAccount, debit: accrued, credit: 0 },
      { compte: accruedAccount, debit: 0, credit: accrued },
    ],
  };
}

// ── P-24-like : ventiler capital / intérêts sur une échéance de prêt comptabilisée en bloc ──
export function draftLoanInstallmentSplit(params: { ledger: Row[]; schedule: LoanScheduleRow[]; chart: Row[] }): PostingDraft | undefined {
  const loanAccount = findAccountByLabel(params.chart, ['emprunts', 'etablissements', 'credit'], 'PASSIF');
  const interestAccount = findAccountByLabel(params.chart, ['interets', 'emprunts'], 'CHARGE');
  if (!loanAccount || !interestAccount) return undefined;
  const row = params.ledger.find((candidate) => candidate.compte === loanAccount && amount(candidate.debit) > 0);
  if (!row) return undefined;
  const schedule = params.schedule.find((candidate) => candidate.date === row.date_ecriture);
  if (!schedule) return undefined;
  const interets = mad(Number(schedule.interets));
  if (cents(interets) <= 0) return undefined;
  return {
    type: 'standard',
    date: row.date_ecriture ?? '',
    journal: 'OD',
    libelle: `Échéance du prêt : part intérêts`,
    certitude: 'certaine',
    preuves: [`BQ:${row.ref_banque}`, `ECHEANCIER:${row.piece}`],
    lignes: [
      { compte: interestAccount, debit: interets, credit: 0 },
      { compte: loanAccount, debit: 0, credit: interets },
    ],
  };
}

// ── P-25/P-26-like : ventiler une facture multi-unités entre usage société et usage personnel ──
const PERSONAL_USE_PATTERN = /\b(?:perso|personnel|personnelle|pour moi|a titre prive|usage prive)\b/i;
const COMPUTER_PATTERN = /\b(?:ordinateurs?|portables?|laptops?|pc|serveurs?|informatique)\b/i;

export interface SplitInvoiceResult {
  companyDraft?: PostingDraft;
  personalDraft?: PostingDraft;
  companyImmoTva?: number;
  excludedPiece?: string;
}

export function draftPersonalUseSplit(params: {
  ledger: Row[];
  chart: Row[];
  policy: JsonObject;
  scenario: JsonObject;
  triggerKeywords: string[];
}): SplitInvoiceResult | undefined {
  const question = findScenarioAnswer(params.scenario, params.triggerKeywords);
  if (!question?.reponse) return undefined;
  const clauses = question.reponse.split(/(?<=[.!?])\s+/).filter((clause) => clause.trim().length > 0);
  if (clauses.length < 2) return undefined;

  const byPiece = new Map<string, Row[]>();
  for (const row of params.ledger) {
    if (!row.piece) continue;
    if (!COMPUTER_PATTERN.test(row.libelle ?? '')) continue;
    const list = byPiece.get(row.piece);
    if (list) list.push(row); else byPiece.set(row.piece, [row]);
  }
  let target: { piece: string; lines: Row[] } | undefined;
  for (const [piece, lines] of byPiece) {
    const quantityMatch = (lines[0]?.libelle ?? '').match(/\b(\d+)\s+\p{L}+s\b/u);
    const quantity = quantityMatch ? Number(quantityMatch[1]) : undefined;
    if (quantity === clauses.length) { target = { piece, lines }; break; }
  }
  if (!target) return undefined;
  const chargeLine = target.lines.find((row) => {
    const nature = params.chart.find((c) => c.code === row.compte)?.nature;
    return nature === 'CHARGE' && amount(row.debit) > 0;
  });
  const vatLine = target.lines.find((row) => normalized(row.compte_libelle).includes('tva') && amount(row.debit) > 0);
  if (!chargeLine || !vatLine) return undefined;
  const unitHt = mad(amount(chargeLine.debit) / clauses.length);
  const unitTva = mad(amount(vatLine.debit) / clauses.length);
  const seuil = Number((params.policy.conventions_comptables as { immobilisation_seuil_ht?: unknown } | undefined)?.immobilisation_seuil_ht);

  const immoAccount = findAccountByLabel(params.chart, ['materiel', 'informatique'], 'ACTIF');
  const immoVatAccount = findAccountByLabel(params.chart, ['tva', 'recuperable', 'immobilisations'], 'ACTIF');
  const debtorAssociateAccount = findAccountByLabel(params.chart, ['comptes', 'courants', 'associes'], 'ACTIF');
  if (!immoAccount || !immoVatAccount || !debtorAssociateAccount) return undefined;

  let companyDraft: PostingDraft | undefined;
  let personalDraft: PostingDraft | undefined;
  let companyImmoTva = 0;

  for (const clause of clauses) {
    const isPersonal = PERSONAL_USE_PATTERN.test(clause);
    if (isPersonal) {
      const total = mad(unitHt + unitTva);
      personalDraft = {
        type: 'standard',
        date: chargeLine.date_ecriture ?? '',
        journal: 'OD',
        libelle: `Usage personnel du dirigeant — compte courant associé débiteur (${target.piece})`,
        certitude: 'certaine',
        question_prealable: question.id,
        preuves: [`GL:${target.piece}`, `SIM:${question.id}`],
        lignes: [
          { compte: debtorAssociateAccount, debit: total, credit: 0 },
          { compte: chargeLine.compte ?? '', debit: 0, credit: unitHt },
          { compte: vatLine.compte ?? '', debit: 0, credit: unitTva },
        ],
      };
    } else if (Number.isFinite(seuil) && unitHt >= seuil) {
      companyDraft = {
        type: 'standard',
        date: chargeLine.date_ecriture ?? '',
        journal: 'OD',
        libelle: `Immobilisation informatique (${target.piece}) + TVA sur immobilisation`,
        certitude: 'certaine',
        question_prealable: question.id,
        preuves: [`GL:${target.piece}`, `SIM:${question.id}`],
        lignes: [
          { compte: immoAccount, debit: unitHt, credit: 0 },
          { compte: immoVatAccount, debit: unitTva, credit: 0 },
          { compte: chargeLine.compte ?? '', debit: 0, credit: unitHt },
          { compte: vatLine.compte ?? '', debit: 0, credit: unitTva },
        ],
      };
      companyImmoTva = unitTva;
    }
  }
  if (!companyDraft && !personalDraft) return undefined;
  return { companyDraft, personalDraft, companyImmoTva, excludedPiece: target.piece };
}

// ── P-27-like : dotations aux amortissements du mois, regroupées par compte d'amortissement ──
export function draftDepreciationEntries(params: { chart: Row[]; assets: { monthlyDepreciation: number; assets: AssetRow[] }; periodEnd: string }): PostingDraft | undefined {
  const dotationAccount = findAccountByLabel(params.chart, ['dotations', 'amortissements', 'immobilisations', 'corporelles'], 'CHARGE');
  if (!dotationAccount || params.assets.assets.length === 0) return undefined;
  const byAmortAccount = new Map<string, number>();
  for (const asset of params.assets.assets) {
    const account = String(asset.compte_amortissement ?? '');
    if (!account) continue;
    const monthly = Number(asset.dotation_mensuelle) || (Number(asset.valeur_origine_ht) * Number(asset.taux_pct)) / 100 / 12;
    byAmortAccount.set(account, (byAmortAccount.get(account) ?? 0) + monthly);
  }
  if (byAmortAccount.size === 0) return undefined;
  const total = mad([...byAmortAccount.values()].reduce((sum, value) => sum + value, 0));
  const lignes: EntryLine[] = [{ compte: dotationAccount, debit: total, credit: 0 }];
  for (const [compte, value] of byAmortAccount) lignes.push({ compte, debit: 0, credit: mad(value) });
  return {
    type: 'standard',
    date: params.periodEnd,
    journal: 'OD',
    libelle: 'Dotations aux amortissements du mois',
    certitude: 'certaine',
    preuves: ['IMMO:registre'],
    lignes,
  };
}

// ── P-28-like : variation de stock après correction d'une quantité négative signalée ───────
export function draftInventoryVariance(params: {
  inventory: Row[];
  ledger: Row[];
  openingBalance: Row[];
  chart: Row[];
  scenario: JsonObject;
  triggerKeywords: string[];
  periodEnd: string;
}): { draft: PostingDraft; question: ScenarioQuestion } | undefined {
  const question = findScenarioAnswer(params.scenario, params.triggerKeywords);
  if (!question?.reponse) return undefined;
  const stockAccount = findAccountByLabel(params.chart, ['marchandises'], 'ACTIF');
  const variationAccount = findAccountByLabel(params.chart, ['variation', 'stocks'], 'CHARGE');
  if (!stockAccount || !variationAccount) return undefined;
  let totalCents = 0;
  for (const row of params.inventory) {
    const quantity = Number(row.quantite);
    let valeur = Math.abs(amount(row.valeur));
    if (quantity < 0) valeur = Math.abs(valeur); // correction confirmée par le client : quantité réellement positive
    const devise = String(row.devise ?? 'MAD');
    if (devise !== 'MAD') {
      const ref = (row.designation ?? '').match(/[A-Z]{2,4}-[A-Z]{2}-\d{4}-\d{2,4}|[A-Z]{2,4}-\d{4}-\d{2,4}/);
      const invoiceLine = ref ? params.ledger.find((candidate) => candidate.piece === ref[0] && candidate.taux_change) : undefined;
      const taux = invoiceLine ? Number(invoiceLine.taux_change) : undefined;
      if (!taux) return undefined;
      valeur = mad(valeur * taux);
    }
    totalCents += cents(valeur);
  }
  const opening = amount(params.openingBalance.find((row) => row.compte === stockAccount)?.debit);
  const variationCents = totalCents - cents(opening);
  if (variationCents === 0) return undefined;
  const variation = mad(Math.abs(variationCents) / 100);
  const increase = variationCents > 0;
  return {
    draft: {
      type: 'standard',
      date: params.periodEnd,
      journal: 'OD',
      libelle: `Variation de stock de marchandises — inventaire ${params.periodEnd}`,
      certitude: 'certaine',
      question_prealable: question.id,
      preuves: [`STOCK:inventaire_${params.periodEnd}`, `SIM:${question.id}`],
      lignes: increase
        ? [{ compte: stockAccount, debit: variation, credit: 0 }, { compte: variationAccount, debit: 0, credit: variation }]
        : [{ compte: variationAccount, debit: variation, credit: 0 }, { compte: stockAccount, debit: 0, credit: variation }],
    },
    question,
  };
}

// ── P-29-like : provision pour perte de change latente sur solde en devise en fin de mois ──
export function draftLatentForexProvision(params: { ledger: Row[]; chart: Row[]; fxRates: Row[]; periodEnd: string }): PostingDraft | undefined {
  const byTier = new Map<string, Row[]>();
  for (const row of params.ledger) {
    const nature = params.chart.find((c) => c.code === row.compte)?.nature;
    if (nature !== 'PASSIF' && nature !== 'ACTIF') continue;
    if (!row.devise || row.devise === 'MAD' || !row.tiers) continue;
    const list = byTier.get(row.compte ?? '');
    if (list) list.push(row); else byTier.set(row.compte ?? '', [row]);
  }
  for (const [compte, rows] of byTier) {
    const devise = rows[0].devise ?? '';
    const invoice = rows.find((row) => row.taux_change && Number(row.montant_devise) > 0 && !row.ref_banque);
    if (!invoice) continue;
    const paid = rows.filter((row) => row !== invoice).reduce((total, row) => total + Number(row.montant_devise ?? 0), 0);
    const remaining = Number(invoice.montant_devise) - paid;
    if (cents(remaining) <= 0) continue;
    const rateRows = params.fxRates.filter((row) => row.devise_1 === devise || row.devise_2 === devise).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const lastRate = rateRows.filter((row) => (row.date ?? '') <= params.periodEnd).pop();
    if (!lastRate) continue;
    const closingRate = lastRate.devise_1 === devise ? Number(lastRate.cours_1) : Number(lastRate.cours_2);
    const historicalRate = Number(invoice.taux_change);
    const forex = calculateForex({ realized: [], latent: [{ id: compte, currency: devise, foreignAmount: remaining, historicalRate, closingRate }] });
    const loss = forex.latent[0]?.amount ?? 0;
    if (cents(loss) <= 0) continue;
    const nature = params.chart.find((c) => c.code === compte)?.nature;
    const ecartAccount = findAccountByLabel(params.chart, nature === 'PASSIF' ? ['ecarts', 'conversion', 'actif'] : ['ecarts', 'conversion', 'passif']);
    const provisionAccount = findAccountByLabel(params.chart, ['provisions', 'pertes', 'change'], 'PASSIF');
    const provisionChargeAccount = findAccountByLabel(params.chart, ['dotations', 'provisions', 'risques'], 'CHARGE');
    if (!ecartAccount || !provisionAccount || !provisionChargeAccount) continue;
    const [year, month] = params.periodEnd.split('-').map(Number);
    const nextMonthStart = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    return {
      type: 'standard',
      date: params.periodEnd,
      journal: 'OD',
      libelle: `Réévaluation dette/créance ${devise} au cours BAM du ${params.periodEnd}`,
      certitude: 'certaine',
      contre_passation_le: nextMonthStart,
      preuves: [`FX:${params.periodEnd}`, `GL:${compte}`],
      lignes: [
        { compte: ecartAccount, tiers: invoice.tiers, debit: loss, credit: 0 },
        { compte, tiers: invoice.tiers, debit: 0, credit: loss },
        { compte: provisionChargeAccount, debit: loss, credit: 0 },
        { compte: provisionAccount, debit: 0, credit: loss },
      ],
    };
  }
  return undefined;
}

// ── P-30/P-31-like : reclasser en charge la TVA non déductible déjà comptabilisée ──────────
export function draftNonDeductibleVatReclass(params: { ledger: Row[]; chart: Row[]; fiscal: JsonObject; periodEnd: string }): PostingDraft[] {
  const rules = (params.fiscal.tva as { non_deductible?: unknown } | undefined)?.non_deductible;
  const ruleList = Array.isArray(rules) ? rules.map((value) => String(value)) : [];
  if (ruleList.length === 0) return [];
  const vatChargeAccount = findAccountByLabel(params.chart, ['tva', 'recuperable', 'charges'], 'ACTIF');
  if (!vatChargeAccount) return [];
  const excludedAccounts = new Set(
    params.chart.filter((row) => {
      const text = normalized(row.libelle);
      return ruleList.some((rule) => rule.split(/[^a-z0-9]+/).filter((token) => token.length >= 6).some((token) => text.includes(normalized(token))));
    }).map((row) => row.code),
  );
  const byPiece = new Map<string, Row[]>();
  for (const row of params.ledger) {
    if (!row.piece) continue;
    const list = byPiece.get(row.piece);
    if (list) list.push(row); else byPiece.set(row.piece, [row]);
  }
  const drafts: PostingDraft[] = [];
  for (const [piece, lines] of byPiece) {
    const vatLine = lines.find((row) => row.compte === vatChargeAccount && amount(row.debit) > 0);
    if (!vatLine) continue;
    const chargeLine = lines.find((row) => row.compte && excludedAccounts.has(row.compte) && amount(row.debit) > 0);
    if (!chargeLine) continue;
    const tva = mad(amount(vatLine.debit));
    drafts.push({
      type: 'standard',
      date: params.periodEnd,
      journal: 'OD',
      libelle: `TVA non déductible — ${chargeLine.libelle ?? piece}`,
      certitude: 'certaine',
      preuves: [`GL:${piece}`],
      lignes: [
        { compte: chargeLine.compte ?? '', debit: tva, credit: 0 },
        { compte: vatChargeAccount, debit: 0, credit: tva },
      ],
    });
  }
  return drafts;
}

// ── P-33-like : écriture de paie mensuelle depuis le journal de paie ───────────────────────
export function draftPayrollEntry(params: { payroll: Row[]; chart: Row[]; periodEnd: string; bankPayment?: Row }): PostingDraft | undefined {
  if (params.payroll.length === 0) return undefined;
  const grossAccount = findAccountByLabel(params.chart, ['appointements', 'salaires'], 'CHARGE');
  const socialAccount = findAccountByLabel(params.chart, ['securite', 'sociale'], 'PASSIF');
  const irAccount = findAccountByLabel(params.chart, ['impots'], 'PASSIF');
  const netAccount = findAccountByLabel(params.chart, ['remunerations', 'dues'], 'PASSIF');
  const employerAccount = findAccountByLabel(params.chart, ['cotisations', 'securite', 'sociale'], 'CHARGE');
  const advanceAccount = findAccountByLabel(params.chart, ['avances', 'acomptes', 'personnel'], 'ACTIF');
  if (!grossAccount || !socialAccount || !irAccount || !netAccount || !employerAccount || !advanceAccount) return undefined;

  const sumCol = (col: string): number => mad(params.payroll.reduce((total, row) => total + cents(amount(row[col])), 0) / 100);
  const brut = sumCol('salaire_brut');
  const cnssSalariale = sumCol('cnss_salariale');
  const amoSalariale = sumCol('amo_salariale');
  const ir = sumCol('ir');
  const net = sumCol('net_a_payer');
  const cnssPatronale = sumCol('cnss_patronale');
  const amoPatronale = sumCol('amo_patronale');
  const avance = sumCol('avance_imputee');
  const salarialSocial = mad(cnssSalariale + amoSalariale);
  const patronalSocial = mad(cnssPatronale + amoPatronale);

  const lignes: EntryLine[] = [
    { compte: grossAccount, debit: brut, credit: 0 },
    { compte: socialAccount, debit: 0, credit: salarialSocial },
    { compte: irAccount, debit: 0, credit: ir },
    { compte: netAccount, debit: 0, credit: net },
    { compte: employerAccount, debit: patronalSocial, credit: 0 },
    { compte: socialAccount, debit: 0, credit: patronalSocial },
  ];
  if (cents(avance) > 0) {
    lignes.push({ compte: netAccount, debit: avance, credit: 0 });
    lignes.push({ compte: advanceAccount, debit: 0, credit: avance });
  }
  return {
    type: 'standard',
    date: params.periodEnd,
    journal: 'OD',
    libelle: 'Paie du mois',
    certitude: 'certaine',
    preuves: [`PAIE:${params.periodEnd.slice(0, 7)}`, ...(params.bankPayment ? [`BQ:${params.bankPayment.ref_banque}`] : [])],
    lignes,
  };
}

// ── P-34-like : majoration de retard sur cotisation sociale payée après échéance ───────────
export function draftSocialLatePenalty(params: { ledger: Row[]; chart: Row[]; priorDeclarations: JsonObject; fiscal: JsonObject; periodEnd: string }): PostingDraft | undefined {
  const key = Object.keys(params.priorDeclarations).find((candidate) => candidate.startsWith('cnss_'));
  if (!key) return undefined;
  const declared = params.priorDeclarations[key] as { montant_bds?: unknown; echeance?: unknown } | undefined;
  if (!declared || typeof declared.montant_bds !== 'number' || typeof declared.echeance !== 'string') return undefined;
  const montantBds: number = declared.montant_bds;
  const echeance: string = declared.echeance;
  const socialAccount = findAccountByLabel(params.chart, ['securite', 'sociale'], 'PASSIF');
  if (!socialAccount) return undefined;
  const payment = params.ledger.find((row) => row.compte === socialAccount && cents(amount(row.debit)) === cents(montantBds));
  if (!payment || !payment.date_ecriture || payment.date_ecriture <= echeance) return undefined;
  const rate = Number(((params.fiscal.cnss as { majoration_retard?: unknown } | undefined)?.majoration_retard as Record<string, unknown> | undefined)?.premier_mois);
  if (!Number.isFinite(rate)) return undefined;
  const penaltyAccount = findAccountByLabel(params.chart, ['penalites', 'amendes'], 'CHARGE');
  if (!penaltyAccount) return undefined;
  const penalty = mad(montantBds * rate);
  return {
    type: 'standard',
    date: params.periodEnd,
    journal: 'OD',
    libelle: `Majoration de retard CNSS (${Math.round(rate * 100)} %)`,
    certitude: 'certaine',
    preuves: [`BQ:${payment.ref_banque}`, `DECL:${key}`],
    lignes: [
      { compte: penaltyAccount, debit: penalty, credit: 0 },
      { compte: socialAccount, debit: 0, credit: penalty },
    ],
  };
}

// ── P-35-like : retenue à la source sur loyer versé à un bailleur personne physique ────────
export function draftRentWithholding(params: { ledger: Row[]; tiers: Row[]; chart: Row[]; fiscal: JsonObject }): PostingDraft | undefined {
  const rentAccount = findAccountByLabel(params.chart, ['locations', 'charges', 'locatives'], 'CHARGE');
  const irAccount = findAccountByLabel(params.chart, ['impots'], 'PASSIF');
  if (!rentAccount || !irAccount) return undefined;
  const landlord = params.tiers.find((row) => String(row.type ?? '') === 'bailleur');
  if (!landlord) return undefined;
  const payment = params.ledger.find((row) => row.compte === rentAccount && amount(row.debit) > 0 && !row.tiers && /\bloyer\b/i.test(row.libelle ?? ''));
  if (!payment) return undefined;
  const grossFromRemark = parseFrenchAmount(landlord.remarques ?? '');
  if (grossFromRemark === undefined) return undefined;
  const netPaid = amount(payment.debit);
  const retenue = mad(grossFromRemark - netPaid);
  if (cents(retenue) <= 0) return undefined;
  return {
    type: 'standard',
    date: payment.date_ecriture ?? '',
    journal: 'OD',
    libelle: `Retenue à la source sur loyer (bailleur personne physique)`,
    certitude: 'certaine',
    preuves: [`BQ:${payment.ref_banque}`, `DOC:bail`],
    lignes: [
      { compte: rentAccount, debit: retenue, credit: 0 },
      { compte: irAccount, debit: 0, credit: retenue },
    ],
  };
}

// ── P-36-like : note de frais avancée par un dirigeant, jamais saisie, réglée par compte courant ──
export function draftAssociateAdvanceExpense(params: { documents: Row[]; chart: Row[]; tiers: Row[] }): { draft: PostingDraft; ht: number; tva: number } | undefined {
  const associateAccount = findAccountByLabel(params.chart, ['comptes', 'courants', 'associes'], 'PASSIF');
  if (!associateAccount) return undefined;
  const document = params.documents.find((row) =>
    (row.fichier ?? '').includes('NOTES_DE_FRAIS') &&
    normalized(row.statut_plateforme).includes('avanc') &&
    normalized(row.statut_plateforme).includes('non saisie'));
  if (!document) return undefined;
  const tier = params.tiers.find((row) => row.code === document.tiers);
  const expenseAccount = findAccountByLabel(params.chart, ['voyages', 'deplacements'], 'CHARGE');
  const vatChargeAccount = findAccountByLabel(params.chart, ['tva', 'recuperable', 'charges'], 'ACTIF');
  if (!expenseAccount || !vatChargeAccount) return undefined;
  const ht = amount(document.ht);
  const tva = amount(document.tva);
  const ttc = mad(ht + tva);
  return {
    ht: mad(ht),
    tva: mad(tva),
    draft: {
      type: 'standard',
      date: document.date ?? '',
      journal: 'OD',
      libelle: `Note de frais avancée par ${tier?.nom ?? document.tiers}`,
      certitude: 'certaine',
      preuves: [`DOC:${document.fichier}`],
      lignes: [
        { compte: expenseAccount, debit: mad(ht), credit: 0 },
        { compte: vatChargeAccount, debit: mad(tva), credit: 0 },
        { compte: associateAccount, debit: 0, credit: ttc },
      ],
    },
  };
}

// ── P-32-like : écriture de règlement TVA finale depuis le résultat calculé ────────────────
export function draftVatSettlement(params: { policy: JsonObject; periodEnd: string; tva: { tva_collectee_exigible: number; tva_deductible_charges: number; tva_deductible_immobilisations: number; tva_due: number; credit_anterieur: number } }): PostingDraft | undefined {
  const text = String(((params.policy.conventions_comptables as { declaration_tva?: unknown } | undefined)?.declaration_tva) ?? '');
  const codes = extractAccountCodes(text);
  if (codes.length < 5) return undefined;
  const [collecteeAccount, chargesAccount, immoAccount, dueAccount, creditAccount] = codes;
  const lignes: EntryLine[] = [
    { compte: collecteeAccount, debit: mad(params.tva.tva_collectee_exigible), credit: 0 },
    { compte: chargesAccount, debit: 0, credit: mad(params.tva.tva_deductible_charges) },
    { compte: immoAccount, debit: 0, credit: mad(params.tva.tva_deductible_immobilisations) },
  ];
  if (params.tva.tva_due > 0) lignes.push({ compte: dueAccount, debit: 0, credit: mad(params.tva.tva_due) });
  else if (params.tva.tva_due === 0 && params.tva.credit_anterieur > 0) { /* pas de solde à passer */ }
  return {
    type: 'standard',
    date: params.periodEnd,
    journal: 'OD',
    libelle: `Déclaration de TVA du mois (régime encaissement)`,
    certitude: 'certaine',
    preuves: ['TVA:detail'],
    lignes,
  };
}
