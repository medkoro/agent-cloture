import { cents, mad } from './money.js';
import type { JsonObject, Row } from './dataset.js';
import type { InternalTransfer, SuspensItem, TruncationFinding } from './bank_engine.js';

export interface VatRow {
  compte?: string;
  debit?: string | number;
  credit?: string | number;
  [key: string]: unknown;
}

export interface VatInput {
  regime: string;
  ledger: VatRow[];
  creditAnterieur?: number;
  dueDate?: string;
  periodEnd?: string;
  accountTypes?: {
    collected: string[];
    charges: string[];
    immobilisations: string[];
  };
  nonDeductible?: string[];
}

export interface VatResult {
  regime: string;
  tva_collectee_exigible: number;
  tva_deductible_charges: number;
  tva_deductible_immobilisations: number;
  credit_anterieur: number;
  tva_due: number;
  echeance: string;
  detail_collectee: VatRow[];
  detail_deductible: VatRow[];
}

const amount = (value: string | number | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalized = (value: unknown): string => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function hasVatLabel(row: VatRow, words: string[]): boolean {
  const text = normalized(`${row.compte_libelle ?? ''} ${row.libelle ?? ''}`);
  return words.some((word) => text.includes(normalized(word)));
}

function inAccountType(row: VatRow, accounts: string[] | undefined, labels: string[]): boolean {
  return accounts ? accounts.includes(String(row.compte ?? '')) : hasVatLabel(row, labels);
}

function isNonDeductible(row: VatRow, rules: string[] = []): boolean {
  const text = normalized(`${row.compte_libelle ?? ''} ${row.libelle ?? ''}`);
  return rules.some((rule) => rule.split(/[^a-z0-9]+/).filter((token) => token.length >= 6).some((token) => text.includes(token) || text.includes(token.slice(0, -2))));
}

export function vatAccountTypes(chart: Row[]): { collected: string[]; charges: string[]; immobilisations: string[] } {
  const collected: string[] = [];
  const charges: string[] = [];
  const immobilisations: string[] = [];
  for (const row of chart) {
    const text = normalized(`${row.code} ${row.libelle}`);
    if (!text.includes('tva')) continue;
    if (text.includes('facturee') || text.includes('collectee')) collected.push(String(row.code ?? ''));
    else if (text.includes('recuperable') && text.includes('immobil')) immobilisations.push(String(row.code ?? ''));
    else if (text.includes('recuperable')) charges.push(String(row.code ?? ''));
  }
  return { collected, charges, immobilisations };
}

export function calculateVat(input: VatInput): VatResult {
  const collecteeRows = input.ledger.filter((row) => inAccountType(row, input.accountTypes?.collected, ['tva facturee', 'tva collectee']) && amount(row.credit) > 0);
  const chargeRows = input.ledger.filter((row) => inAccountType(row, input.accountTypes?.charges, ['tva recuperable sur charges']) && amount(row.debit) > 0 && !isNonDeductible(row, input.nonDeductible));
  const assetRows = input.ledger.filter((row) => inAccountType(row, input.accountTypes?.immobilisations, ['tva recuperable sur les immobilisations', 'tva recuperable sur immobilisations']) && amount(row.debit) > 0 && !isNonDeductible(row, input.nonDeductible));
  const collectee = mad(collecteeRows.reduce((total, row) => total + amount(row.credit), 0));
  const charges = mad(chargeRows.reduce((total, row) => total + amount(row.debit), 0));
  const immobilisations = mad(assetRows.reduce((total, row) => total + amount(row.debit), 0));
  const credit = mad(input.creditAnterieur ?? 0);
  const due = mad(Math.max(0, collectee - charges - immobilisations - credit));

  return {
    regime: input.regime,
    tva_collectee_exigible: collectee,
    tva_deductible_charges: charges,
    tva_deductible_immobilisations: immobilisations,
    credit_anterieur: credit,
    tva_due: due,
    echeance: input.dueDate ?? input.periodEnd ?? '',
    detail_collectee: collecteeRows,
    detail_deductible: [...chargeRows, ...assetRows],
  };
}

export interface VatAnnotation {
  piece: string;
  tva_exclue: number;
  motif: string;
}

export type ImputationStatut = 'total' | 'partiel' | 'rejet' | 'virement_interne' | 'hors_champ' | 'non_imputable' | 'annotation_exclue';

export interface Imputation {
  banque?: string;
  id_ligne?: string;
  facture: string;
  tiers?: string;
  montant_impute: number;
  tva: number;
  statut: ImputationStatut;
  motif?: string;
}

export interface VatEncaissementInput {
  banks: { key: string; rows: Row[] }[];
  ledger: Row[];
  openItems: Row[];
  tiers: Row[];
  chart: Row[];
  fiscal: JsonObject;
  policy: JsonObject;
  societe: JsonObject;
  transfers: InternalTransfer[];
  truncations: TruncationFinding[];
  suspens: Record<string, SuspensItem[]>;
  period: string;
  dueDate: string;
  annotations?: VatAnnotation[];
  creditAnterieur?: number;
}

export interface VatEncaissementResult extends VatResult {
  imputations_collectee: Imputation[];
  imputations_deductible: Imputation[];
}

const normRef = (value: unknown): string => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const REF_LONG = /[A-Z]{2,4}[\s-]?\d{2,4}[\s-]?\d{3,5}/;
const REF_SHORT = /[A-Z]{2,4}[\s-]?\d{3,5}/;
const FEE_PATTERN = /\b(?:frais|commission|tenue|com)\b/i;
const NUMERIC_TOKEN = /\d{5,}/g;

const parseRef = (text: string): string | undefined => {
  const value = String(text ?? '');
  const long = value.match(REF_LONG);
  if (long) return normRef(long[0]);
  const short = value.match(REF_SHORT);
  return short ? normRef(short[0]) : undefined;
};

const refAlias = (piece: string): string => {
  const tokens = String(piece ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (tokens.length <= 1) return normRef(piece);
  return tokens[tokens.length - 1].match(/^\d/) ? `${tokens[0]}${tokens[tokens.length - 1]}` : normRef(piece);
};

const LEGAL_FORM = /^(?:sarl|sas|sua|sa|sci|eurl|sca|snc|ei|srl|gmbh|llc|ltd|inc|co|saas)$/;
const tierTokens = (name: string): string[] => normalized(name).split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !LEGAL_FORM.test(token));
const labelTokens = (label: string): string[] => normalized(label).split(/[^a-z0-9]+/).filter((token) => token.length >= 3);

const matchesTier = (libelle: string, tokens: string[]): boolean => {
  if (tokens.length === 0) return false;
  const label = labelTokens(libelle);
  return tokens.every((token) => label.some((candidate) => token.startsWith(candidate) || candidate.startsWith(token)));
};

const numericTokens = (value: string): string[] => (String(value ?? '').match(NUMERIC_TOKEN) ?? []);

const sharesNumericRef = (a: unknown, b: unknown): boolean => {
  const tokensA = numericTokens(String(a ?? ''));
  const tokensB = numericTokens(String(b ?? ''));
  return tokensA.some((token) => tokensB.includes(token));
};

interface Invoice {
  key: string;
  alias: string;
  piece: string;
  tiers?: string;
  compte?: string;
  ttc: number;
  tva: number;
  immo: boolean;
  vatEvidence: boolean;
  chargeAccounts: Set<string>;
  date: string;
  recognized: boolean;
}

interface Payment {
  banque?: string;
  idLigne?: string;
  piece?: string;
  libelle: string;
  montant: number;
  date: string;
  mode: 'banque' | 'cheque' | 'especes';
}

interface SettlementEvent {
  banque?: string;
  idLigne?: string;
  libelle: string;
  montant: number;
  date: string;
  rejete: boolean;
}

export function calculateVatEncaissement(input: VatEncaissementInput): VatEncaissementResult {
  const periodPrefix = String(input.period ?? '');
  const inPeriod = (row: Row): boolean => String(row.date_operation ?? '').startsWith(periodPrefix);

  const accountTypes = vatAccountTypes(input.chart);
  const chartCodes = new Set(input.chart.map((row) => String(row.code ?? '')));
  const tiersByCode = new Map<string, Row>(input.tiers.map((row) => [String(row.code ?? ''), row]));
  const caisseCompte = String(((input.societe.caisse as { compte?: unknown } | null | undefined)?.compte) ?? '');
  const bankAccounts = new Set(
    (((input.societe.banques as Array<{ compte?: unknown } | null | undefined> | null | undefined) ?? [])
      .map((bank) => String(bank?.compte ?? ''))
      .filter((compte) => compte.length > 0)),
  );
  const parentByAccount = new Map<string, string>();
  for (const row of input.chart) {
    const code = String(row.code ?? '');
    const parent = String(row.compte_parent ?? '');
    if (code && parent) parentByAccount.set(code, parent);
  }
  const collectifsOfNature = (isClientNature: boolean): string[] => {
    const parents = new Set<string>();
    for (const tier of input.tiers) {
      if ((String(tier.type ?? '') === 'client') !== isClientNature) continue;
      const parent = String(tier.compte ?? '') ? parentByAccount.get(String(tier.compte ?? '')) : undefined;
      if (parent) parents.add(parent);
    }
    return [...parents];
  };
  const clientCollectifs = collectifsOfNature(true);
  const supplierCollectifs = collectifsOfNature(false);
  const onCollectifs = (compte: string, prefixes: string[]): boolean => prefixes.some((prefix) => compte.startsWith(prefix));

  const feesRate = (() => {
    const nature = ((input.fiscal?.tva as { taux_par_nature?: unknown } | undefined)?.taux_par_nature as Record<string, unknown> | undefined)?.['frais_bancaires'];
    return Number.isFinite(Number(nature)) ? Number(nature) : 0;
  })();
  const especesPlafond = (() => {
    const rule = ((input.fiscal?.tva as { reglement_especes?: unknown } | undefined)?.reglement_especes as Record<string, unknown> | undefined)?.['plafond_deductible_par_jour_et_fournisseur'];
    const parsed = Number(rule);
    if (!Number.isFinite(parsed)) {
      throw new Error('Paramètre fiscal manquant ou invalide : fiscal.tva.reglement_especes.plafond_deductible_par_jour_et_fournisseur');
    }
    return parsed;
  })();
  const ecartSeuil = (() => {
    const text = String(((input.policy?.conventions_comptables as { ecart_reglement?: unknown } | undefined)?.ecart_reglement) ?? '');
    const match = text.match(/≤\s*(\d+)/);
    return match ? Number(match[1]) : 0;
  })();
  const nonDeductibleRules = (() => {
    const list = (input.fiscal?.tva as { non_deductible?: unknown } | undefined)?.non_deductible;
    return Array.isArray(list) ? list.map((value) => String(value)) : [];
  })();
  const excludedAccounts = new Set(
    input.chart
      .filter((row) => isNonDeductible(row as VatRow, nonDeductibleRules))
      .map((row) => String(row.code ?? '')),
  );
  const annotationsByKey = new Map((input.annotations ?? []).map((item) => [normRef(item.piece), item]));
  const creditAnterieur = mad(input.creditAnterieur ?? 0);

  const clients = new Map<string, Invoice>();
  const expenses = new Map<string, Invoice>();

  const ensureInvoice = (map: Map<string, Invoice>, piece: string, tc: { tiers?: string; compte?: string }): Invoice => {
    const key = normRef(piece);
    let invoice = map.get(key);
    if (!invoice) {
      invoice = {
        key,
        alias: refAlias(piece),
        piece,
        tiers: tc.tiers,
        compte: tc.compte,
        ttc: 0,
        tva: 0,
        immo: false,
        vatEvidence: false,
        chargeAccounts: new Set(),
        date: '',
        recognized: false,
      };
      map.set(key, invoice);
    }
    if (!invoice.tiers && tc.tiers) invoice.tiers = tc.tiers;
    if (!invoice.compte && tc.compte) invoice.compte = tc.compte;
    return invoice;
  };

  for (const row of input.openItems) {
    const piece = String(row.piece ?? '');
    if (!piece) continue;
    const tiers = String(row.tiers ?? '');
    const tier = tiersByCode.get(tiers);
    const map = tier?.type === 'client' ? clients : expenses;
    const invoice = ensureInvoice(map, piece, { tiers, compte: tier?.compte });
    invoice.ttc = Math.max(invoice.ttc, amount(row.montant_ttc));
    invoice.tva = Math.max(invoice.tva, amount(row.dont_tva));
    if (!invoice.date) invoice.date = String(row.date_piece ?? '');
  }

  interface GlBundle {
    tiers?: string;
    clientTtc: number;
    clientTva: number;
    supplierTtc: number;
    supplierTva: number;
    immo: boolean;
    caisseCredit: number;
    chargeAccounts: Set<string>;
    date: string;
  }

  const bundles = new Map<string, GlBundle>();
  for (const row of input.ledger) {
    const piece = String(row.piece ?? '');
    if (!piece) continue;
    const compte = String(row.compte ?? '');
    if (bankAccounts.has(compte)) continue;
    const debit = amount(row.debit);
    const credit = amount(row.credit);
    let bundle = bundles.get(piece);
    if (!bundle) {
      bundle = { clientTtc: 0, clientTva: 0, supplierTtc: 0, supplierTva: 0, immo: false, caisseCredit: 0, chargeAccounts: new Set(), date: '' };
      bundles.set(piece, bundle);
    }
    const tiers = String(row.tiers ?? '');
    if (tiers && !bundle.tiers) bundle.tiers = tiers;
    if (onCollectifs(compte, clientCollectifs) && debit > 0) bundle.clientTtc += debit;
    if (onCollectifs(compte, supplierCollectifs) && credit > 0) bundle.supplierTtc += credit;
    if (accountTypes.collected.includes(compte) && credit > 0) bundle.clientTva += credit;
    if (accountTypes.charges.includes(compte) && debit > 0) {
      bundle.supplierTva += debit;
      bundle.date ||= String(row.date_ecriture ?? '');
    }
    if (accountTypes.immobilisations.includes(compte) && debit > 0) {
      bundle.supplierTva += debit;
      bundle.immo = true;
      bundle.date ||= String(row.date_ecriture ?? '');
    }
    if (compte === caisseCompte && credit > 0) {
      bundle.caisseCredit += credit;
      bundle.date ||= String(row.date_ecriture ?? '');
    }
    const isBank = bankAccounts.has(compte) || compte === caisseCompte;
    const isDebt = onCollectifs(compte, clientCollectifs) || onCollectifs(compte, supplierCollectifs);
    const isVat = accountTypes.collected.includes(compte) || accountTypes.charges.includes(compte) || accountTypes.immobilisations.includes(compte);
    if (debit > 0 && !isBank && !isDebt && !isVat) bundle.chargeAccounts.add(compte);
  }

  for (const [piece, bundle] of bundles) {
    const tiers = bundle.tiers ? String(bundle.tiers) : undefined;
    const compte = tiers ? tiersByCode.get(tiers)?.compte : undefined;
    if (bundle.clientTtc > 0) {
      const invoice = ensureInvoice(clients, piece, { tiers, compte });
      invoice.ttc = Math.max(invoice.ttc, mad(bundle.clientTtc));
      invoice.tva = Math.max(invoice.tva, mad(bundle.clientTva));
      if (!invoice.date) invoice.date = bundle.date;
    } else if (bundle.supplierTtc > 0 || bundle.caisseCredit > 0 || bundle.supplierTva > 0) {
      const invoice = ensureInvoice(expenses, piece, { tiers, compte });
      const ttc = bundle.supplierTtc > 0 ? bundle.supplierTtc : bundle.caisseCredit;
      if (ttc > 0) invoice.ttc = Math.max(invoice.ttc, mad(ttc));
      if (bundle.supplierTva > 0) {
        invoice.tva = Math.max(invoice.tva, mad(bundle.supplierTva));
        invoice.vatEvidence = true;
      }
      if (bundle.immo) invoice.immo = true;
      for (const account of bundle.chargeAccounts) invoice.chargeAccounts.add(account);
      if (!invoice.date) invoice.date = bundle.date;
    }
  }

  const finalizeRecognition = (map: Map<string, Invoice>): void => {
    for (const invoice of map.values()) {
      invoice.recognized = Boolean((invoice.compte && chartCodes.has(invoice.compte)) || invoice.vatEvidence || invoice.chargeAccounts.size > 0);
    }
  };
  finalizeRecognition(clients);
  finalizeRecognition(expenses);

  const payments: Payment[] = [];
  const settlements: SettlementEvent[] = [];

  const truncationByKey = new Map(input.truncations.map((item) => [`${item.banque}:${item.id_ligne}`, item.montant_corrige]));
  const impayesByBank = new Map<string, SuspensItem[]>();
  for (const [key, items] of Object.entries(input.suspens ?? {})) {
    impayesByBank.set(key, items.filter((item) => item.type === 'impaye'));
  }
  const transferSourceIds = new Set(input.transfers.map((item) => `${item.source.key}:${item.source.id_ligne}`));
  const transferTargetIds = new Set(input.transfers.map((item) => `${item.cible.key}:${item.cible.id_ligne}`));
  const bankDebitIds = new Set<string>();
  for (const bank of input.banks) {
    for (const row of bank.rows) {
      if (cents(amount(row.debit)) > 0) bankDebitIds.add(`${bank.key}:${String(row.id_ligne ?? '')}`);
    }
  }

  input.banks.forEach((bank, bankIndex) => {
    const impayes = impayesByBank.get(bank.key) ?? [];
    const rejectedDebitIds = new Set(impayes.map((item) => item.id_ligne).filter((id): id is string => Boolean(id)));
    bank.rows.forEach((row, rowIndex) => {
      if (!inPeriod(row)) return;
      const id = String(row.id_ligne ?? '');
      const debit = amount(row.debit);
      const credit = amount(row.credit);
      if (debit > 0) {
        if (transferSourceIds.has(`${bank.key}:${id}`)) return;
        if (rejectedDebitIds.has(id)) return;
        const corrected = truncationByKey.get(`${bank.key}:${id}`);
        payments.push({
          banque: bank.key,
          idLigne: id,
          libelle: String(row.libelle ?? ''),
          montant: corrected !== undefined ? corrected : debit,
          date: String(row.date_operation ?? ''),
          mode: 'banque',
        });
        return;
      }
      if (credit > 0) {
        if (transferTargetIds.has(`${bank.key}:${id}`)) return;
        settlements.push({
          banque: bank.key,
          idLigne: id,
          libelle: String(row.libelle ?? ''),
          montant: credit,
          date: String(row.date_operation ?? ''),
          rejete: impayes.some((item) => sharesNumericRef(item.libelle ?? '', String(row.libelle ?? ''))),
        });
      }
    });
  });

  for (const row of input.ledger) {
    if (String(row.compte ?? '') !== caisseCompte) continue;
    const credit = amount(row.credit);
    if (credit <= 0) continue;
    payments.push({
      piece: String(row.piece ?? ''),
      libelle: String(row.libelle ?? ''),
      montant: credit,
      date: String(row.date_ecriture ?? ''),
      mode: 'especes',
    });
  }

  for (const [key, items] of Object.entries(input.suspens ?? {})) {
    for (const item of items) {
      if (item.type !== 'cheque_emis_non_debite') continue;
      if (item.piece && bankDebitIds.has(`${key}:${item.piece}`)) continue;
      payments.push({
        banque: key,
        idLigne: item.id_ligne,
        piece: item.piece,
        libelle: String(item.libelle ?? ''),
        montant: item.montant,
        date: String(item.date ?? ''),
        mode: 'cheque',
      });
    }
  }

  const byDate = (a: { date: string; banque?: string; idLigne?: string }, b: { date: string; banque?: string; idLigne?: string }): number =>
    a.date.localeCompare(b.date) || (a.banque ?? '').localeCompare(b.banque ?? '') || (a.idLigne ?? '').localeCompare(b.idLigne ?? '');
  payments.sort(byDate);
  settlements.sort(byDate);

  const paidExpenses = new Map<string, number>();
  const paidClients = new Map<string, number>();
  const imputationsCollected: Imputation[] = [];
  const imputationsDeductible: Imputation[] = [];
  let collecteeCents = 0;
  let chargesCents = 0;
  let immoCents = 0;

  const remainingOf = (invoice: Invoice, paid: Map<string, number>): number => mad(invoice.ttc - (paid.get(invoice.key) ?? 0));

  const shiftCents = (source: { cents: number }, amountCent: number): void => {
    source.cents += amountCent;
  };

  const resolveInvoice = (map: Map<string, Invoice>, paid: Map<string, number>, libelle: string, piece: string | undefined): Invoice | undefined => {
    const ref = parseRef(libelle) ?? (piece ? normRef(piece) : undefined);
    if (ref) {
      for (const invoice of map.values()) {
        if (invoice.recognized && remainingOf(invoice, paid) > 0 && (invoice.key === ref || invoice.alias === ref)) return invoice;
      }
    }
    return undefined;
  };

  const bestTier = (libelle: string, type: string): Row | undefined => {
    let best: Row | undefined;
    let bestScore = -1;
    for (const tier of input.tiers) {
      if (String(tier.type ?? '') !== type) continue;
      const tokens = tierTokens(String(tier.nom ?? ''));
      if (!matchesTier(libelle, tokens)) continue;
      const score = tokens.join('').length;
      if (score > bestScore || (score === bestScore && best && String(best.code ?? '') > String(tier.code ?? ''))) {
        best = tier;
        bestScore = score;
      }
    }
    return best;
  };

  const fifoOpen = (map: Map<string, Invoice>, paid: Map<string, number>, tiers: string): Invoice | undefined =>
    [...map.values()]
      .filter((invoice) => invoice.recognized && invoice.tiers === tiers && remainingOf(invoice, paid) > 0)
      .sort((a, b) => a.date.localeCompare(b.date) || a.piece.localeCompare(b.piece))[0];

  const byMontant = (map: Map<string, Invoice>, paid: Map<string, number>, montant: number): Invoice | undefined => {
    let best: Invoice | undefined;
    let bestDiff = Infinity;
    for (const invoice of map.values()) {
      const due = remainingOf(invoice, paid);
      if (!invoice.recognized || due <= 0) continue;
      const diff = Math.abs(due - montant);
      if (cents(diff) <= cents(ecartSeuil) && diff < bestDiff) {
        best = invoice;
        bestDiff = diff;
      }
    }
    return best;
  };

  const redactDeductible = (payment: Payment): void => {
    if (feesRate > 0 && FEE_PATTERN.test(payment.libelle)) {
      const tva = mad((payment.montant * feesRate) / (100 + feesRate));
      chargesCents += cents(tva);
      imputationsDeductible.push({
        banque: payment.banque,
        id_ligne: payment.idLigne,
        facture: payment.idLigne ?? payment.piece ?? 'FRAIS',
        montant_impute: mad(payment.montant),
        tva,
        statut: 'total',
      });
      return;
    }

    let remaining = mad(payment.montant);
    let invoice = resolveInvoice(expenses, paidExpenses, payment.libelle, payment.piece);
    if (!invoice) {
      const tier = bestTier(payment.libelle, 'fournisseur');
      if (tier) invoice = fifoOpen(expenses, paidExpenses, String(tier.code ?? ''));
    }
    if (!invoice) invoice = byMontant(expenses, paidExpenses, remaining);

    if (!invoice) {
      imputationsDeductible.push({
        banque: payment.banque,
        id_ligne: payment.idLigne,
        facture: payment.idLigne ?? payment.piece ?? 'non_imputable',
        montant_impute: mad(remaining),
        tva: 0,
        statut: 'non_imputable',
      });
      return;
    }

    while (remaining > 0 && invoice) {
      const take = Math.min(remaining, remainingOf(invoice, paidExpenses));
      const excluded = [...invoice.chargeAccounts].some((account) => excludedAccounts.has(account));
      let tvaRaw = mad((invoice.tva * take) / invoice.ttc);
      let statut: ImputationStatut = 'total';
      paidExpenses.set(invoice.key, (paidExpenses.get(invoice.key) ?? 0) + take);
      if (excluded) {
        tvaRaw = 0;
        statut = 'non_imputable';
      } else if (payment.mode === 'especes' && cents(Math.min(take, especesPlafond)) < cents(take)) {
        tvaRaw = mad((invoice.tva * Math.min(take, especesPlafond)) / invoice.ttc);
        statut = 'partiel';
      }
      const annotation = annotationsByKey.get(invoice.key);
      if (annotation) {
        tvaRaw = Math.max(0, mad(tvaRaw) - annotation.tva_exclue);
        statut = 'annotation_exclue';
      }
      const tva = mad(tvaRaw);
      if (invoice.immo) immoCents += cents(tva);
      else chargesCents += cents(tva);
      imputationsDeductible.push({
        banque: payment.banque,
        id_ligne: payment.idLigne,
        facture: annotation ? invoice.piece : invoice.piece,
        tiers: invoice.tiers,
        montant_impute: mad(take),
        tva,
        statut,
        motif: annotation?.motif,
      });
      remaining = mad(remaining - take);
      invoice = invoice.tiers ? fifoOpen(expenses, paidExpenses, invoice.tiers) : undefined;
    }
  };

  const redactSettlement = (event: SettlementEvent): void => {
    let remaining = mad(event.montant);
    let invoice = resolveInvoice(clients, paidClients, event.libelle, undefined);
    if (!invoice) {
      const tier = bestTier(event.libelle, 'client');
      if (tier) invoice = fifoOpen(clients, paidClients, String(tier.code ?? ''));
    }
    if (!invoice) invoice = byMontant(clients, paidClients, remaining);

    if (!invoice) {
      imputationsCollected.push({
        banque: event.banque,
        id_ligne: event.idLigne,
        facture: event.idLigne ?? 'HORS_CHAMP',
        montant_impute: mad(remaining),
        tva: 0,
        statut: 'hors_champ',
      });
      return;
    }

    if (event.rejete) {
      const take = Math.min(remaining, remainingOf(invoice, paidClients));
      imputationsCollected.push({
        banque: event.banque,
        id_ligne: event.idLigne,
        facture: invoice.piece,
        tiers: invoice.tiers,
        montant_impute: mad(take),
        tva: 0,
        statut: 'rejet',
      });
      return;
    }

    while (remaining > 0 && invoice) {
      const take = Math.min(remaining, remainingOf(invoice, paidClients));
      const remainingBefore = remainingOf(invoice, paidClients);
      const remainingAfter = mad(remainingBefore - take);
      const closingEcart = cents(remainingAfter) <= cents(ecartSeuil) && remainingAfter > 0;
      const tva = mad(closingEcart ? invoice.tva : (invoice.tva * take) / invoice.ttc);
      let statut: ImputationStatut = 'partiel';
      paidClients.set(invoice.key, (paidClients.get(invoice.key) ?? 0) + take);
      if (cents(remainingAfter) === 0) {
        statut = 'total';
      } else if (closingEcart) {
        statut = 'total';
        paidClients.set(invoice.key, invoice.ttc);
        if (feesRate > 0) {
          const ecartTva = mad((remainingAfter * feesRate) / (100 + feesRate));
          chargesCents += cents(ecartTva);
          imputationsDeductible.push({
            facture: invoice.piece,
            tiers: invoice.tiers,
            montant_impute: remainingAfter,
            tva: ecartTva,
            statut: 'total',
          });
        }
      }
      collecteeCents += cents(tva);
      imputationsCollected.push({
        banque: event.banque,
        id_ligne: event.idLigne,
        facture: invoice.piece,
        tiers: invoice.tiers,
        montant_impute: mad(take),
        tva,
        statut,
      });
      remaining = mad(remaining - take);
      invoice = invoice.tiers ? fifoOpen(clients, paidClients, invoice.tiers) : undefined;
    }
  };

  for (const payment of payments) redactDeductible(payment);
  for (const event of settlements) redactSettlement(event);

  const collectee = mad(collecteeCents / 100);
  const charges = mad(chargesCents / 100);
  const immobilisations = mad(immoCents / 100);
  const due = mad(Math.max(0, collectee - charges - immobilisations - creditAnterieur));

  return {
    regime: 'encaissement',
    tva_collectee_exigible: collectee,
    tva_deductible_charges: charges,
    tva_deductible_immobilisations: immobilisations,
    credit_anterieur: creditAnterieur,
    tva_due: due,
    echeance: input.dueDate,
    detail_collectee: imputationsCollected as unknown as VatRow[],
    detail_deductible: imputationsDeductible as unknown as VatRow[],
    imputations_collectee: imputationsCollected,
    imputations_deductible: imputationsDeductible,
  };
}