// Détections d'anomalies « sans écriture » (RUN2) : contrôles négatifs, délais, créances
// douteuses, TVA/IR de la période précédente, revue analytique. Rien n'est en dur : comptes,
// tiers et seuils sont dérivés du plan comptable, de tiers.csv, de parametres_fiscaux.json et
// de politique_cabinet.json injectés. Si une donnée nécessaire manque, la fonction ne produit
// rien plutôt que d'inventer un compte, un tiers ou un montant.
import type { JsonObject, Row } from './dataset.js';
import type { SuspensItem } from './bank_engine.js';
import { findAccountByLabel, findTierByLibelle, inTransitItems, type InTransitItem } from './postings.js';
import { cents, mad } from './money.js';

export interface AnomalyDraft {
  titre: string;
  description: string;
  preuves: string[];
  gravite?: string;
  actionAttendue?: string;
  question?: string;
}

interface BankLike {
  key: string;
  name: string;
  rows: Row[];
  header: JsonObject;
}

const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

// ── ANO-11-like : suspens bancaires légitimes en transit, aucune écriture requise ──
export function detectLegitimateSuspens(banks: BankLike[], ledger: Row[]): AnomalyDraft[] {
  const items: { bank: string; item: InTransitItem }[] = [];
  for (const bank of banks) {
    for (const item of inTransitItems(bank, ledger)) items.push({ bank: bank.key, item });
  }
  if (items.length === 0) return [];
  const detail = items
    .map(({ bank, item }) => `${item.type === 'remise_non_creditee' ? 'remise de chèque non créditée' : 'chèque émis non débité'} ${item.ref ?? ''} (${bank}, ${item.montant} MAD)`.trim())
    .join(' ; ');
  return [{
    titre: 'Suspens bancaires légitimes (en transit)',
    description: `Ces suspens de rapprochement s'expliquent par le délai d'encaissement/débit normal et ne nécessitent aucune écriture : ${detail}.`,
    preuves: items.map(({ bank, item }) => `BQ:${bank}:${item.ref ?? 'transit'}`),
    gravite: 'info',
    actionAttendue: 'aucune_ecriture',
  }];
}

// ── ANO-14-like : règlement client réparti sur plusieurs factures (lettrage à cheval) ──
export function detectMultiInvoiceLettrage(openItems: Row[], tiers: Row[]): AnomalyDraft[] {
  const byTiers = new Map<string, Row[]>();
  for (const row of openItems) {
    if (!row.tiers) continue;
    const list = byTiers.get(row.tiers);
    if (list) list.push(row); else byTiers.set(row.tiers, [row]);
  }
  const tierByCode = new Map(tiers.map((row) => [String(row.code ?? ''), row]));
  const drafts: AnomalyDraft[] = [];
  for (const [code, rows] of byTiers) {
    if (rows.length < 2) continue;
    const tier = tierByCode.get(code);
    if (!tier || String(tier.type ?? '') !== 'client') continue;
    const pieces = rows.map((row) => row.piece).filter(Boolean).join(', ');
    const total = mad(rows.reduce((sum, row) => sum + numberValue(row.montant_ttc), 0));
    drafts.push({
      titre: `Lettrage à cheval sur plusieurs factures — ${tier.nom}`,
      description: `Le client ${tier.nom} a ${rows.length} factures ouvertes à lettrer (${pieces}) pour ${total.toFixed(2)} MAD au total : règlement multi-facture réparti, lettrage manuel à effectuer.`,
      preuves: rows.map((row) => `OUVERTS:${row.piece}`),
      gravite: 'info',
      actionAttendue: 'lettrage',
    });
  }
  return drafts;
}

// ── ANO-18-like : facture fournisseur impayée au-delà du délai légal ──
export function detectOverdueSupplierInvoices(params: {
  openItems: Row[];
  chart: Row[];
  tiers: Row[];
  fiscal: JsonObject;
  periodEnd: string;
}): AnomalyDraft[] {
  const natureByCode = new Map(params.chart.map((row) => [String(row.code ?? ''), String(row.nature ?? '')]));
  const delais = (params.fiscal.delais_paiement as Record<string, unknown> | undefined) ?? {};
  const defaultDays = Number(delais.delai_defaut_sans_convention_jours);
  if (!Number.isFinite(defaultDays)) return [];
  const penaliteRate = Number((delais.penalite as { premier_mois?: unknown } | undefined)?.premier_mois);
  const tierByCode = new Map(params.tiers.map((row) => [String(row.code ?? ''), row]));
  const drafts: AnomalyDraft[] = [];
  for (const row of params.openItems) {
    if (natureByCode.get(row.compte ?? '') !== 'PASSIF') continue;
    if (!row.date_echeance) continue;
    const overdueDays = daysBetween(row.date_echeance, params.periodEnd);
    if (overdueDays <= defaultDays) continue;
    const tier = tierByCode.get(row.tiers ?? '');
    const montant = mad(numberValue(row.montant_ttc));
    const penalty = Number.isFinite(penaliteRate) ? mad(montant * penaliteRate) : undefined;
    drafts.push({
      titre: `Facture fournisseur ${row.piece} impayée au-delà du délai légal (${overdueDays} jours)`,
      description: `${tier?.nom ?? row.tiers} n'a pas été réglé pour la facture ${row.piece} (${montant.toFixed(2)} MAD, échue le ${row.date_echeance}) : ${overdueDays} jours de retard, au-delà du délai légal de ${defaultDays} jours${penalty !== undefined ? ` — pénalité de retard estimée ${penalty.toFixed(2)} MAD` : ''}.`,
      preuves: [`OUVERTS:${row.piece}`, 'PARAM:delais_paiement'],
      gravite: 'haute',
      actionAttendue: 'alerte',
    });
  }
  return drafts;
}

const DOUBTFUL_AGE_DAYS = 270;

// ── ANO-19-like : créance client douteuse/litigieuse (ancienneté + chèque rejeté) ──
export function detectDoubtfulReceivables(params: {
  openItems: Row[];
  tiers: Row[];
  suspensByBank: Record<string, SuspensItem[]>;
  periodEnd: string;
}): AnomalyDraft[] {
  const tierByCode = new Map(params.tiers.map((row) => [String(row.code ?? ''), row]));
  const impayeTierCodes = new Set<string>();
  for (const items of Object.values(params.suspensByBank)) {
    for (const item of items) {
      if (item.type !== 'impaye') continue;
      const tier = findTierByLibelle(params.tiers, 'client', item.libelle ?? '');
      if (tier?.code) impayeTierCodes.add(String(tier.code));
    }
  }
  const drafts: AnomalyDraft[] = [];
  for (const row of params.openItems) {
    if (!row.tiers || !impayeTierCodes.has(row.tiers)) continue;
    if (!row.date_piece) continue;
    const ageDays = daysBetween(row.date_piece, params.periodEnd);
    if (ageDays < DOUBTFUL_AGE_DAYS) continue;
    const tier = tierByCode.get(row.tiers);
    const montant = mad(numberValue(row.montant_ttc));
    const months = Math.floor(ageDays / 30);
    drafts.push({
      titre: `Créance douteuse ${tier?.nom ?? row.tiers} — facture ${row.piece} en litige`,
      description: `La facture ${row.piece} (${montant.toFixed(2)} MAD) du client ${tier?.nom ?? row.tiers} est ouverte depuis ${months} mois et un règlement par chèque a été rejeté par la banque : créance douteuse/litigieuse, provision à valider par l'expert-comptable — aucune écriture n'est postée sans décision.`,
      preuves: [`OUVERTS:${row.piece}`],
      gravite: 'haute',
      actionAttendue: 'escalade_expert',
      question: `Le client ${tier?.nom ?? row.tiers} n'a pas réglé la facture ${row.piece} (${montant.toFixed(2)} MAD) depuis plus de ${months} mois et un chèque a été rejeté : confirmez-vous le litige et son statut ?`,
    });
  }
  return drafts;
}

// ── ANO-38-like : écart entre le paiement TVA constaté et la TVA due déclarée du mois précédent ──
export function detectVatDeclarationGap(params: {
  ledger: Row[];
  chart: Row[];
  priorDeclarations: JsonObject;
  priorPeriod: string;
  fiscal: JsonObject;
}): AnomalyDraft[] {
  const declared = params.priorDeclarations[`tva_${params.priorPeriod}`] as { tva_due?: unknown } | undefined;
  if (!declared || typeof declared.tva_due !== 'number') return [];
  const vatDueAccount = findAccountByLabel(params.chart, ['tva', 'due'], 'PASSIF');
  if (!vatDueAccount) return [];
  const payments = params.ledger.filter((row) => row.compte === vatDueAccount && numberValue(row.debit) > 0);
  if (payments.length === 0) return [];
  const paid = mad(payments.reduce((sum, row) => sum + cents(numberValue(row.debit)), 0) / 100);
  const declaredDue = mad(declared.tva_due);
  if (cents(paid) === cents(declaredDue)) return [];
  const ecart = mad((cents(declaredDue) - cents(paid)) / 100);
  const penaliteRate = Number(((params.fiscal.tva as Record<string, unknown> | undefined)?.penalite_retard as { premier_mois?: unknown } | undefined)?.premier_mois);
  const penalty = Number.isFinite(penaliteRate) ? mad(Math.abs(ecart) * penaliteRate) : undefined;
  const payment = payments[0];
  return [{
    titre: `Écart de règlement TVA ${params.priorPeriod} : ${paid.toFixed(2)} payés pour ${declaredDue.toFixed(2)} déclarés`,
    description: `Le paiement TVA enregistré le ${payment.date_ecriture} (${paid.toFixed(2)} MAD, GL:${payment.ecriture_id}) diffère de la TVA due déclarée pour ${params.priorPeriod} (${declaredDue.toFixed(2)} MAD) : écart de ${ecart.toFixed(2)} MAD${penalty !== undefined ? `, pénalité de retard estimée ${penalty.toFixed(2)} MAD` : ''}.`,
    preuves: [`GL:${payment.ecriture_id ?? payment.piece ?? ''}`, `DECL:tva_${params.priorPeriod}`],
    gravite: 'haute',
    actionAttendue: 'alerte',
    question: `Le paiement TVA de ${params.priorPeriod} enregistré le ${payment.date_ecriture} est de ${paid.toFixed(2)} MAD alors que la déclaration indique ${declaredDue.toFixed(2)} MAD (écart ${ecart.toFixed(2)} MAD) : confirmez-vous cet écart et la régularisation ?`,
  }];
}

// ── ANO-42-like : retenue IR sur salaires non versée à l'échéance ──
export function detectUnpaidWithholdingTax(params: {
  ledger: Row[];
  chart: Row[];
  priorDeclarations: JsonObject;
  fiscal: JsonObject;
  periodEnd: string;
}): AnomalyDraft[] {
  const key = Object.keys(params.priorDeclarations).find((candidate) => candidate.startsWith('ir_salaires_'));
  if (!key) return [];
  const declared = params.priorDeclarations[key] as { montant?: unknown; echeance?: unknown; periode?: unknown } | undefined;
  if (!declared || typeof declared.montant !== 'number' || typeof declared.echeance !== 'string') return [];
  const montantDeclare = declared.montant;
  const echeance = declared.echeance;
  if (echeance > params.periodEnd) return [];
  const irAccount = findAccountByLabel(params.chart, ['impots'], 'PASSIF');
  if (!irAccount) return [];
  const alreadyPaid = params.ledger.some((row) => row.compte === irAccount && numberValue(row.debit) >= montantDeclare - 0.01);
  if (alreadyPaid) return [];
  const penaliteRate = Number(((params.fiscal.ir_salaires as Record<string, unknown> | undefined)?.penalite_retard as { premier_mois?: unknown } | undefined)?.premier_mois);
  const majoration = Number.isFinite(penaliteRate) ? mad(montantDeclare * penaliteRate) : undefined;
  const periode = String(declared.periode ?? key.replace('ir_salaires_', ''));
  const montant = mad(montantDeclare);
  return [{
    titre: `IR sur salaires de ${periode} (${montant.toFixed(2)} MAD) non versé à l'échéance du ${echeance}`,
    description: `La retenue IR sur salaires (${montant.toFixed(2)} MAD, période ${periode}) n'apparaît pas réglée au grand livre au ${params.periodEnd}, alors que l'échéance était le ${echeance}${majoration !== undefined ? ` : majoration de retard estimée ${majoration.toFixed(2)} MAD` : ''}.`,
    preuves: [`OUVERTURE:${irAccount}`, `DECL:${key}`],
    gravite: 'haute',
    actionAttendue: 'alerte',
    question: `La retenue IR sur salaires de ${periode} (${montant.toFixed(2)} MAD, échéance ${echeance}) n'apparaît pas réglée au ${params.periodEnd} : confirmez-vous le retard de versement ?`,
  }];
}

// ── ANO-47-like : revue analytique vs baseline historique (7 mois précédents) ──
export function detectAnalyticVariances(params: {
  ledger: Row[];
  history: Row[];
  policy: JsonObject;
  period: string;
}): AnomalyDraft[] {
  if (params.history.length === 0) return [];
  const materialite = (params.policy.materialite as Record<string, unknown> | undefined) ?? {};
  const pctThreshold = Number(materialite.seuil_revue_analytique_pct);
  const madThreshold = Number(materialite.seuil_revue_analytique_mad);
  if (!Number.isFinite(pctThreshold) && !Number.isFinite(madThreshold)) return [];

  const byAccount = new Map<string, number[]>();
  const months = new Set<string>();
  for (const row of params.history) {
    if (!row.compte) continue;
    if (row.mois) months.add(row.mois);
    const value = numberValue(row.solde_debiteur_positif);
    const list = byAccount.get(row.compte);
    if (list) list.push(value); else byAccount.set(row.compte, [value]);
  }

  const currentByAccount = new Map<string, number>();
  for (const row of params.ledger) {
    if (!row.compte || !byAccount.has(row.compte)) continue;
    const net = numberValue(row.debit) - numberValue(row.credit);
    currentByAccount.set(row.compte, (currentByAccount.get(row.compte) ?? 0) + net);
  }

  const flagged: { compte: string; baseline: number; actuel: number; delta: number }[] = [];
  for (const [compte, values] of byAccount) {
    const actuel = currentByAccount.get(compte) ?? 0;
    const baseline = values.reduce((sum, value) => sum + value, 0) / values.length;
    const delta = actuel - baseline;
    const pctExceeded = Number.isFinite(pctThreshold) && Math.abs(baseline) > 0 && Math.abs(delta) / Math.abs(baseline) >= pctThreshold;
    const madExceeded = Number.isFinite(madThreshold) && Math.abs(delta) >= madThreshold;
    if (pctExceeded || madExceeded) flagged.push({ compte, baseline: mad(baseline), actuel: mad(actuel), delta: mad(delta) });
  }
  if (flagged.length === 0) return [];

  const sortedMonths = [...months].sort();
  const range = sortedMonths.length ? `${sortedMonths[0]}..${sortedMonths[sortedMonths.length - 1]}` : params.period;
  const detail = flagged
    .map((item) => `${item.compte} (baseline ${item.baseline.toFixed(2)} → ${params.period} ${item.actuel.toFixed(2)}, écart ${item.delta.toFixed(2)} MAD)`)
    .join(' ; ');
  return [{
    titre: 'Revue analytique : variation(s) significative(s) vs baseline historique',
    description: `Comparaison de la balance ${params.period} aux moyennes mensuelles ${range} : ${detail}.`,
    preuves: [`HISTO:${range}`, ...flagged.map((item) => `GL:compte:${item.compte}`)],
    gravite: 'info',
    actionAttendue: 'alerte',
  }];
}
