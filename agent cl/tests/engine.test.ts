import { describe, expect, it } from 'vitest';
import { ClosingEngine } from '../src/engine/closing_engine.js';
import { loadClosingDataset, nextMonthEnd } from '../src/engine/dataset.js';
import { checkLedgerIntegrity } from '../src/engine/integrity.js';
import { detectInternalTransfers, detectTruncations, matchBankToLedger, verifyStatementChecksum, type StatementChecksum, type SuspensItem } from '../src/engine/bank_engine.js';
import { calculateVatEncaissement, vatAccountTypes } from '../src/engine/vat_engine.js';
import { OutputSchema } from '../src/contracts/output.js';

const dataset = new URL('../../datasets/atlas_negoce/', import.meta.url).pathname.replace(/^\//, '').replace(/\//g, '\\');

describe('ClosingEngine générique', () => {
  it('does not invent entries when source evidence is insufficient', async () => {
    const output = await new ClosingEngine(dataset, '2026-08').run();
    expect(output.propositions).toHaveLength(0);
    expect(OutputSchema.safeParse(output).success).toBe(true);
    expect(JSON.stringify(output)).not.toContain('Atlas Négoce');
    expect(JSON.stringify(output)).not.toContain('P-01');
    expect(output.anomalies.some((item) => item.titre.includes('TVA'))).toBe(true);
  });

  it('derives bank balances from the injected files', async () => {
    const output = await new ClosingEngine(dataset, '2026-08').run();
    expect(Object.keys(output.rapprochements)).toEqual(expect.arrayContaining(['alpha', 'omega']));
    expect(output.rapprochements.alpha.solde_releve).toBe(351616.26);
    expect(output.rapprochements.omega.solde_releve).toBe(246075.19);
    expect(output.rapprochements.alpha.corrections).toEqual([]);
    expect(output.rapprochements.omega.corrections).toEqual([]);
  });
});

describe('dataset dynamique', () => {
  it('charge societe, postes ouverts, déclarations antérieures et clés bancaires canoniques', async () => {
    const ds = await loadClosingDataset(dataset, '2026-08');
    expect(String((ds.societe.derniere_periode_verrouillee as { fin?: unknown } | undefined)?.fin)).toBe('2026-07-31');
    expect(ds.openItems.length).toBeGreaterThan(0);
    expect(ds.priorDeclarations).toHaveProperty('tva_2026-07');
    expect(ds.banks.map((b) => b.key)).toEqual(['banque_alpha', 'banque_omega']);
  });
});

describe('integrite du grand livre', () => {
  const chart = [
    { code: '3421', libelle: 'Clients', nature: 'ACTIF', lettrable: 'oui', compte_parent: '' },
    { code: '34210001', libelle: 'Clients — X', nature: 'ACTIF', lettrable: 'oui', compte_parent: '3421' },
    { code: '4411', libelle: 'Fournisseurs', nature: 'PASSIF', lettrable: 'oui', compte_parent: '' },
    { code: '44110001', libelle: 'Fournisseurs — Y', nature: 'PASSIF', lettrable: 'oui', compte_parent: '4411' },
  ];
  it('detecte ecriture desequilibree, periode verrouillee et compte collectif', () => {
    const ledger = [
      { ecriture_id: 'E1', piece: 'P1', date_ecriture: '2026-08-22', compte: '6133', debit: '850.00', credit: '0' },
      { ecriture_id: 'E2', piece: 'P2', date_ecriture: '2026-07-28', compte: '4411', debit: '100', credit: '0' },
      { ecriture_id: 'E2', piece: 'P2', date_ecriture: '2026-07-28', compte: '6134', debit: '0', credit: '100' },
    ];
    const issues = checkLedgerIntegrity(ledger, chart, '2026-07-31');
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'ecriture_desequilibree', ecriture_id: 'E1', ecart: 850 }),
      expect.objectContaining({ type: 'periode_verrouillee', ecriture_id: 'E2', piece: 'P2' }),
      expect.objectContaining({ type: 'compte_collectif', ecriture_id: 'E2', compte: '4411' }),
    ]));
  });
  it('ne signale rien sur un grand livre propre', () => {
    const ok = [{ ecriture_id: 'E1', piece: 'P1', date_ecriture: '2026-08-01', compte: '6133', debit: '10', credit: '0' },
                { ecriture_id: 'E1', piece: 'P1', date_ecriture: '2026-08-01', compte: '44110001', debit: '0', credit: '10' }];
    expect(checkLedgerIntegrity(ok, chart, '2026-07-31')).toEqual([]);
  });
});

describe('bank_engine', () => {
  it('verifie la coherence des totaux imprimes', () => {
    const header = { solde_initial: 1000, total_debit_imprime: 500, total_credit_imprime: 300, solde_final_imprime: 800 };
    const rows = [{ id_ligne: 'X1', debit: '500.00', credit: '0' }, { id_ligne: 'X2', debit: '0', credit: '300.00' }];
    expect(verifyStatementChecksum(header, rows).coherent).toBe(true);
    const rowsTronques = [{ id_ligne: 'X1', debit: '100.00', credit: '0' }, { id_ligne: 'X2', debit: '0', credit: '300.00' }];
    expect(verifyStatementChecksum(header, rowsTronques).ecart_debit).toBe(400);
  });
  it('identifie la troncature OCR par rapprochement avec la facture du grand livre', () => {
    const checksum = { ecart_debit: 4000, ecart_credit: 0, ecart_solde: 4000 } as StatementChecksum;
    const rows = [{ id_ligne: 'O3', libelle: 'VIR EMIS FOURN TE-5521', debit: '365.12', credit: '0' }];
    const ledger = [
      { piece: 'TE-5521', compte: '6142', debit: '3637.60', credit: '0' },
      { piece: 'TE-5521', compte: '34552', debit: '727.52', credit: '0' },
      { piece: 'TE-5521', compte: '44110012', debit: '0', credit: '4365.12' },
    ];
    const found = detectTruncations({ key: 'banque_omega', rows }, checksum, ledger);
    expect(found).toEqual([{ banque: 'banque_omega', id_ligne: 'O3', piece: 'TE-5521', montant_extrait: 365.12, montant_corrige: 4365.12, ecart: 4000 }]);
  });
  it('detecte les virements internes entre comptes propres', () => {
    const a = { key: 'banque_alpha', rows: [{ id_ligne: 'A13', date_operation: '2026-08-19', libelle: 'VIR EMIS VERS AUTRE COMPTE', debit: '50000.00', credit: '0' }] };
    const b = { key: 'banque_omega', rows: [{ id_ligne: 'O2', date_operation: '2026-08-19', libelle: 'VIR RECU AUTRE COMPTE', debit: '0', credit: '50000.00' }] };
    expect(detectInternalTransfers([a, b])).toEqual([{ montant: 50000, date: '2026-08-19', source: { key: 'banque_alpha', id_ligne: 'A13' }, cible: { key: 'banque_omega', id_ligne: 'O2' } }]);
  });
  it('traite les champs den-tete manquants comme zero', () => {
    const summary = verifyStatementChecksum({}, [{ id_ligne: 'X1', debit: '0', credit: '0' }]);
    expect(summary).toMatchObject({ ecart_debit: 0, ecart_credit: 0, ecart_solde: 0, coherent: true });
  });
  it('scanne le sens credit quand lecart porte sur les credits', () => {
    const checksum = { ecart_debit: 0, ecart_credit: 4000, ecart_solde: 4000 } as StatementChecksum;
    const rows = [{ id_ligne: 'O4', libelle: 'VIR RECU CLIENT TE-5521', debit: '0', credit: '365.12' }];
    const ledger = [
      { piece: 'TE-5521', compte: '6142', debit: '3637.60', credit: '0' },
      { piece: 'TE-5521', compte: '34552', debit: '727.52', credit: '0' },
      { piece: 'TE-5521', compte: '44110012', debit: '0', credit: '4365.12' },
    ];
    const found = detectTruncations({ key: 'banque_omega', rows }, checksum, ledger);
    expect(found).toEqual([{ banque: 'banque_omega', id_ligne: 'O4', piece: 'TE-5521', montant_extrait: 365.12, montant_corrige: 4365.12, ecart: 4000 }]);
  });
  it('detecte des troncatures debit et credit simultanees', () => {
    const checksum = { ecart_debit: 4000, ecart_credit: 1000, ecart_solde: 5000 } as StatementChecksum;
    const rows = [
      { id_ligne: 'O3', libelle: 'VIR EMIS FOURN TE-5521', debit: '365.12', credit: '0' },
      { id_ligne: 'O6', libelle: 'VIR RECU CLIENT TE-5530', debit: '0', credit: '222.00' },
    ];
    const ledger = [
      { piece: 'TE-5521', compte: '44110012', debit: '0', credit: '4365.12' },
      { piece: 'TE-5530', compte: '44110014', debit: '0', credit: '1222.00' },
    ];
    const found = detectTruncations({ key: 'banque_omega', rows }, checksum, ledger);
    expect(found).toEqual([
      { banque: 'banque_omega', id_ligne: 'O3', piece: 'TE-5521', montant_extrait: 365.12, montant_corrige: 4365.12, ecart: 4000 },
      { banque: 'banque_omega', id_ligne: 'O6', piece: 'TE-5530', montant_extrait: 222, montant_corrige: 1222, ecart: 1000 },
    ]);
  });
  it('ignore une incoherence a la centime pres', () => {
    const checksum = { ecart_debit: 4000, ecart_credit: 0, ecart_solde: 4000 } as StatementChecksum;
    const rows = [{ id_ligne: 'O3', libelle: 'VIR EMIS FOURN TE-5521', debit: '365.13', credit: '0' }];
    const ledger = [{ piece: 'TE-5521', compte: '44110012', debit: '0', credit: '4365.12' }];
    expect(detectTruncations({ key: 'banque_omega', rows }, checksum, ledger)).toEqual([]);
  });
  it('ne consomme une ligne que par un seul virement', () => {
    const a = { key: 'banque_alpha', rows: [{ id_ligne: 'A13', date_operation: '2026-08-19', debit: '50000.00', credit: '0' }] };
    const b = { key: 'banque_omega', rows: [
      { id_ligne: 'O2', date_operation: '2026-08-19', debit: '0', credit: '50000.00' },
      { id_ligne: 'O5', date_operation: '2026-08-19', debit: '0', credit: '50000.00' },
    ] };
    const found = detectInternalTransfers([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ source: { key: 'banque_alpha', id_ligne: 'A13' }, cible: { key: 'banque_omega', id_ligne: 'O2' } });
  });
it('ignore les virements de dates differentes', () => {
    const a = { key: 'banque_alpha', rows: [{ id_ligne: 'A13', date_operation: '2026-08-19', debit: '50000.00', credit: '0.00' }] };
    const b = { key: 'banque_omega', rows: [{ id_ligne: 'O2', date_operation: '2026-08-20', debit: '0.00', credit: '50000.00' }] };
    expect(detectInternalTransfers([a, b])).toEqual([]);
  });
});

describe('matchBankToLedger', () => {
  const bankAccount = '51411';

  it('type les suspens: remise, cheque emis, frais et impaye (appariement GL deux sens)', () => {
    const bank = {
      key: 'banque_alpha',
      rows: [
        { id_ligne: 'A06', date_operation: '2026-08-08', libelle: 'FRAIS TENUE DE COMPTE TTC', debit: '110.00', credit: '0.00' },
        { id_ligne: 'A15', date_operation: '2026-08-21', libelle: 'REMISE CHQ N 7781204 BTP CHAOUIA', debit: '0.00', credit: '24000.00' },
        { id_ligne: 'A23', date_operation: '2026-08-30', libelle: 'CHQ IMPAYE N 7781204 BTP CHAOUIA MOTIF SANS PROVISION', debit: '24000.00', credit: '0.00' },
      ],
    };
    const ledger = [
      { ecriture_id: 'E1', piece: 'RCHQ-0831', date_ecriture: '2026-08-31', compte: bankAccount, debit: '9600.00', credit: '0.00', libelle: 'Remise cheque 0831' },
      { ecriture_id: 'E2', piece: 'CHQ-0004521', date_ecriture: '2026-08-28', compte: bankAccount, debit: '0.00', credit: '3120.00', libelle: 'Cheque 0004521' },
    ];
    const result = matchBankToLedger(bank, ledger, bankAccount);
    expect(result.matchedBank).toEqual([]);
    expect(result.suspens).toEqual([
      { type: 'frais_non_comptabilise', id_ligne: 'A06', libelle: 'FRAIS TENUE DE COMPTE TTC', montant: 110, date: '2026-08-08' },
      { type: 'impaye', id_ligne: 'A23', libelle: 'CHQ IMPAYE N 7781204 BTP CHAOUIA MOTIF SANS PROVISION', montant: 24000, date: '2026-08-30' },
      { type: 'remise_non_creditee', ref: 'RCHQ-0831', libelle: 'Remise cheque 0831', montant: 9600, date: '2026-08-31', piece: 'RCHQ-0831' },
      { type: 'cheque_emis_non_debite', ref: 'CHQ-0004521', libelle: 'Cheque 0004521', montant: 3120, date: '2026-08-28', piece: 'CHQ-0004521' },
    ]);
  });

  it('apparie au centime via ref_banque = id_ligne (debit banque <-> credit GL) et ignore les autres comptes', () => {
    const bank = {
      key: 'banque_alpha',
      rows: [
        { id_ligne: 'A01', date_operation: '2026-08-01', libelle: 'PRLV SOFTCLOUD SC-2026-1187', debit: '43200.00', credit: '0.00' },
      ],
    };
    const ledger = [
      { ecriture_id: 'E1', piece: 'BQ1', date_ecriture: '2026-08-01', compte: '51412', debit: '0.00', credit: '43200.00', ref_banque: 'A01', libelle: 'leurre autre compte' },
      { ecriture_id: 'E2', piece: 'BQ2', date_ecriture: '2026-08-01', compte: bankAccount, debit: '0.00', credit: '43200.00', ref_banque: 'A01', libelle: 'PRLV fournisseur' },
    ];
    const result = matchBankToLedger(bank, ledger, bankAccount);
    expect(result.matchedBank).toEqual(['A01']);
    expect(result.suspens).toEqual([]);
  });

  it('apparie par token de reference commun du libelle (PIECE_PATTERN) contre la piece GL, insensible a la casse', () => {
    const bank = {
      key: 'banque_omega',
      rows: [
        { id_ligne: 'O07', date_operation: '2026-08-02', libelle: 'VIR RECU CLIENT TE-5521', debit: '0.00', credit: '365.12' },
      ],
    };
    const ledger = [
      { ecriture_id: 'E1', piece: 'te-5521', date_ecriture: '2026-08-02', compte: bankAccount, debit: '365.12', credit: '0.00', libelle: 'Encaissement clinique' },
    ];
    const result = matchBankToLedger(bank, ledger, bankAccount);
    expect(result.matchedBank).toEqual(['O07']);
    expect(result.suspens).toEqual([]);
  });

  it('classe non_categorise, consacre le credit d un impaye (pas d encaissement duplicate) et type les encaissements', () => {
    const bank = {
      key: 'banque_alpha',
      rows: [
        { id_ligne: 'A40', date_operation: '2026-08-10', libelle: 'REMISE CHQ N 1234567 CLIENT X', debit: '0.00', credit: '700.00' },
        { id_ligne: 'A41', date_operation: '2026-08-11', libelle: 'CHQ IMPAYE N 1234567 CLIENT X', debit: '700.00', credit: '0.00' },
        { id_ligne: 'A42', date_operation: '2026-08-12', libelle: 'VIR SPONTANE INEXPLIQUE', debit: '300.00', credit: '0.00' },
        { id_ligne: 'A43', date_operation: '2026-08-13', libelle: 'VIR RECU ENCAISSEMENT LIBRE', debit: '0.00', credit: '900.00' },
      ],
    };
    const result = matchBankToLedger(bank, [], bankAccount);
    expect(result.matchedBank).toEqual([]);
    expect(result.suspens).toEqual([
      { type: 'impaye', id_ligne: 'A41', libelle: 'CHQ IMPAYE N 1234567 CLIENT X', montant: 700, date: '2026-08-11' },
      { type: 'non_categorise', id_ligne: 'A42', libelle: 'VIR SPONTANE INEXPLIQUE', montant: 300, date: '2026-08-12' },
      { type: 'encaissement_non_comptabilise', id_ligne: 'A43', libelle: 'VIR RECU ENCAISSEMENT LIBRE', montant: 900, date: '2026-08-13' },
    ]);
  });
});

describe('vat_engine régime encaissement', () => {
  const chart = [
    { code: '3421', libelle: 'Clients (collectif)', compte_parent: '' },
    { code: '34210001', libelle: 'Clients — Anfa Park', compte_parent: '3421' },
    { code: '34210004', libelle: 'Clients — Clinique Al Amal', compte_parent: '3421' },
    { code: '4411', libelle: 'Fournisseurs (collectif)', compte_parent: '' },
    { code: '44110012', libelle: 'Fournisseurs — Transit Express', compte_parent: '4411' },
    { code: '44110010', libelle: 'Fournisseurs — InfoTech', compte_parent: '4411' },
    { code: '34552', libelle: 'État — TVA récupérable sur charges', compte_parent: '' },
    { code: '34551', libelle: 'État — TVA récupérable sur les immobilisations', compte_parent: '' },
    { code: '4455', libelle: 'État — TVA facturée', compte_parent: '' },
    { code: '5161', libelle: 'Caisse', compte_parent: '' },
    { code: '6125', libelle: 'Achats non stockés (carburant)', compte_parent: '' },
  ];

  const baseInput = {
    banks: [],
    ledger: [],
    openItems: [],
    tiers: [],
    chart,
    fiscal: {
      tva: {
        regime_dossier: 'encaissement',
        taux_par_nature: { frais_bancaires: 10 },
        non_deductible: ['carburant des véhicules de tourisme'],
        reglement_especes: { plafond_deductible_par_jour_et_fournisseur: 5000 },
      },
    },
    policy: { conventions_comptables: { ecart_reglement: 'Écart ≤ 50 MAD sur un règlement client = frais bancaires : 6147 HT + 34552 TVA 10 %' } },
    societe: { caisse: { compte: '5161' } },
    transfers: [],
    truncations: [],
    suspens: {},
    period: '2026-08',
    dueDate: '2026-09-30',
  };

  it('proratise la TVA déductible des espèces au plafond journalier (2 000 × 5 000/12 000 = 833,33)', () => {
    const result = calculateVatEncaissement({
      ...baseInput,
      openItems: [{ tiers: 'F012', piece: 'TE-5498', date_piece: '2026-08-14', montant_ttc: '12000.00', dont_tva: '2000.00' }],
      tiers: [{ code: 'F012', type: 'fournisseur', nom: 'Transit Express SARL', compte: '44110012' }],
      ledger: [{ piece: 'TE-5498', compte: '5161', debit: '0', credit: '12000.00' }],
    });
    expect(result.tva_deductible_charges).toBe(833.33);
    expect(result.tva_deductible_immobilisations).toBe(0);
    expect(result.imputations_deductible).toContainEqual(expect.objectContaining({
      facture: 'TE-5498',
      tiers: 'F012',
      montant_impute: 12000,
      tva: 833.33,
      statut: 'partiel',
    }));
  });

  it('impute un encaissement partiel au prorata (10 000 × 14 000/60 000 = 2 333,33)', () => {
    const result = calculateVatEncaissement({
      ...baseInput,
      banks: [{ key: 'banque_alpha', rows: [{ id_ligne: 'A05', date_operation: '2026-08-07', libelle: 'VIR RECU CLINIQUE AL AMAL SA', debit: '0', credit: '14000.00' }] }],
      openItems: [{ tiers: 'C004', piece: 'FAC-2026-0421', date_piece: '2026-07-02', montant_ttc: '60000.00', dont_tva: '10000.00' }],
      tiers: [{ code: 'C004', type: 'client', nom: 'Clinique Al Amal SA', compte: '34210004' }],
    });
    expect(result.tva_collectee_exigible).toBe(2333.33);
    expect(result.tva_due).toBe(2333.33);
    expect(result.imputations_collectee).toContainEqual(expect.objectContaining({
      facture: 'FAC-2026-0421',
      tiers: 'C004',
      montant_impute: 14000,
      tva: 2333.33,
      statut: 'partiel',
    }));
  });

  it('soustrait tva_exclue de la TVA de la pièce annotée (statut annotation_exclue, motif conservé)', () => {
    const result = calculateVatEncaissement({
      ...baseInput,
      banks: [{ key: 'banque_alpha', rows: [{ id_ligne: 'A08', date_operation: '2026-08-12', libelle: 'VIR EMIS INFOTECH DISTRIBUTION IT-2026-0933', debit: '34800.00', credit: '0' }] }],
      openItems: [{ tiers: 'F010', piece: 'IT-2026-0933', date_piece: '2026-08-12', montant_ttc: '34800.00', dont_tva: '5800.00' }],
      tiers: [{ code: 'F010', type: 'fournisseur', nom: 'InfoTech Distribution SARL', compte: '44110010' }],
      annotations: [{ piece: 'IT-2026-0933', tva_exclue: 2900, motif: 'ordinateur portable à usage personnel' }],
    });
    expect(result.tva_deductible_charges).toBe(2900);
    expect(result.imputations_deductible).toContainEqual(expect.objectContaining({
      facture: 'IT-2026-0933',
      tva: 2900,
      statut: 'annotation_exclue',
      motif: 'ordinateur portable à usage personnel',
    }));
  });

  it('exclut la TVA d une facture dont la ligne de charge est sur un compte non déductible (carburant)', () => {
    const result = calculateVatEncaissement({
      ...baseInput,
      tiers: [{ code: 'F001', type: 'fournisseur', nom: 'Fournisseur X', compte: '44110001' }],
      openItems: [{ tiers: 'F001', piece: 'TK-0808', date_piece: '2026-08-08', montant_ttc: '600.00', dont_tva: '100.00' }],
      ledger: [{ piece: 'TK-0808', compte: '5161', debit: '0', credit: '600.00' }],
    });
    expect(result.tva_deductible_charges).toBe(0);
  });

  it('soude une facture presque soldée si l écart est ≤ seuil, TVA pleine + TVA 10 % déductible sur l écart', () => {
    const result = calculateVatEncaissement({
      ...baseInput,
      banks: [{ key: 'banque_alpha', rows: [{ id_ligne: 'A22', date_operation: '2026-08-29', libelle: 'VIR RECU GRP IMMOBILIER ANFA PARK FAC 0426', debit: '0', credit: '71982.00' }] }],
      openItems: [{ tiers: 'C001', piece: 'FAC-2026-0426', date_piece: '2026-08-12', montant_ttc: '72000.00', dont_tva: '12000.00' }],
      tiers: [{ code: 'C001', type: 'client', nom: 'Groupe Immobilier Anfa Park SA', compte: '34210001' }],
    });
    expect(result.tva_collectee_exigible).toBe(12000);
    expect(result.tva_deductible_charges).toBe(1.64);
    expect(result.imputations_collectee).toContainEqual(expect.objectContaining({ facture: 'FAC-2026-0426', tva: 12000, statut: 'total' }));
  });

  it('calcule la TVA due du dossier atlas_negoce (55 000 − 51 883,49 = 3 116,51)', async () => {
    const ds = await loadClosingDataset(dataset, '2026-08');
    const transfers = detectInternalTransfers(ds.banks.map((bank) => ({ key: bank.key, rows: bank.rows })));
    const truncations = ds.banks.flatMap((bank) => detectTruncations(
      { key: bank.key, rows: bank.rows },
      verifyStatementChecksum(bank.header, bank.rows),
      ds.ledger,
      ds.chart,
    ));
    const suspens: Record<string, SuspensItem[]> = {};
    for (const bank of ds.banks) {
      suspens[bank.key] = matchBankToLedger({ key: bank.key, rows: bank.rows }, ds.ledger, String(bank.header.compte_gl)).suspens;
    }
    const input = {
      banks: ds.banks.map((bank) => ({ key: bank.key, rows: bank.rows })),
      ledger: ds.ledger,
      openItems: ds.openItems,
      tiers: ds.tiers,
      chart: ds.chart,
      fiscal: ds.fiscal,
      policy: ds.policy,
      societe: ds.societe,
      transfers,
      truncations,
      suspens,
      period: ds.period,
      dueDate: nextMonthEnd(ds.period),
    };
    const result = calculateVatEncaissement(input);
    expect(result.tva_collectee_exigible).toBe(55000);
    expect(result.tva_deductible_charges).toBe(51883.49);
    expect(result.tva_deductible_immobilisations).toBe(0);
    expect(result.tva_due).toBe(3116.51);
    expect(result.imputations_collectee.find((item) => item.facture === 'FAC-2026-0412')).toMatchObject({ statut: 'total', tva: 19800 });
    expect(result.imputations_collectee.find((item) => item.facture === 'A25')).toMatchObject({ statut: 'hors_champ', tva: 0 });
    expect(result.imputations_collectee.find((item) => item.facture === 'FAC-2025-0877')).toMatchObject({ statut: 'rejet', tva: 0 });
    expect(result.imputations_deductible.find((item) => item.facture === 'ED-77812')).toMatchObject({ statut: 'total', tva: 35760 });
    expect(result.imputations_deductible.find((item) => item.facture === 'TE-5498')).toMatchObject({ statut: 'partiel', tva: 833.33 });
  });

  it('applique l annotation IT-2026-0933 sur le dossier (51 883,49 − 2 900 = 48 983,49)', async () => {
    const ds = await loadClosingDataset(dataset, '2026-08');
    const transfers = detectInternalTransfers(ds.banks.map((bank) => ({ key: bank.key, rows: bank.rows })));
    const truncations = ds.banks.flatMap((bank) => detectTruncations(
      { key: bank.key, rows: bank.rows },
      verifyStatementChecksum(bank.header, bank.rows),
      ds.ledger,
      ds.chart,
    ));
    const suspens: Record<string, SuspensItem[]> = {};
    for (const bank of ds.banks) {
      suspens[bank.key] = matchBankToLedger({ key: bank.key, rows: bank.rows }, ds.ledger, String(bank.header.compte_gl)).suspens;
    }
    const input = {
      banks: ds.banks.map((bank) => ({ key: bank.key, rows: bank.rows })),
      ledger: ds.ledger,
      openItems: ds.openItems,
      tiers: ds.tiers,
      chart: ds.chart,
      fiscal: ds.fiscal,
      policy: ds.policy,
      societe: ds.societe,
      transfers,
      truncations,
      suspens,
      period: ds.period,
      dueDate: nextMonthEnd(ds.period),
      annotations: [{ piece: 'IT-2026-0933', tva_exclue: 2900, motif: 'ordinateur portable à usage personnel' }],
    };
    const result = calculateVatEncaissement(input);
    expect(result.tva_deductible_charges).toBe(48983.49);
    expect(result.tva_due).toBe(6016.51);
    expect(result.imputations_deductible).toContainEqual(expect.objectContaining({
      facture: 'IT-2026-0933',
      tva: 2900,
      statut: 'annotation_exclue',
      motif: 'ordinateur portable à usage personnel',
    }));
  });
});
