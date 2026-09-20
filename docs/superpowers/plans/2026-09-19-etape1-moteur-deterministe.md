# Plan d'implémentation — Étape 1 : Moteur déterministe

> **Pour les agents exécutants :** utiliser superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans, tâche par tâche (cases `- [ ]`).

**Objectif :** Le moteur `src/engine/` calcule tout (intégrité, relevés, TVA encaissement) de façon déterministe, 100 % pilotée par les données injectées — le LLM ne fait aucune arithmétique.

**Architecture :** 4 modules purs (`dataset`, `integrity`, `bank_engine`, `vat_engine`) coordonnés par `closing_engine`. Le lettrage encaissements→factures reconstruit l'exigibilité TVA au régime de l'encaissement (règle fiscale : prorata espèces, non-déductibilité par compte, annotations optionnelles pour l'usage personnel).

**Stack :** TypeScript ESM, Vitest, zod. Répertoire de travail : `agent cl/`. Repo git à la racine.

**Spéc :** prompt utilisateur (étape 1) + décisions validées : prorata espèces ✓, interface annotations ✓, renommage `bank_engine.ts`/`vat_engine.ts` ✓.

## Contraintes globales

1. **Zéro hardcoding** : aucun nom de société, aucun montant, aucune référence de pièce dans le code logique. Les seules constantes : formats de dates, expressions régulières génériques d'extraction de références, listes de tokens de langue pour catégoriser (ex. « frais », « commission »).
2. Tout montant arrondi au centime via `money.ts` (`cents`/`mad`).
3. Toute valeur spécifique à Atlas n'apparaît que dans les **tests** (le dataset est le fixture), jamais dans `src/`.
4. `npm test` et `npm run typecheck` doivent passer après chaque tâche (depuis `agent cl/`).
5. Les fonctions existantes restent exportées sous leur nom si d'autres modules les importent (`matchBankEntries`, `calculateVat`).

## Découvertes clés de la recherche (à lire avant d'exécuter)

- `dataset.ts` ne charge **pas** `societe.json` (date de verrouillage), ni `postes_ouverts_*.csv`, ni `declarations_et_rapprochements_anterieurs.json` — indispensable pour l'intégrité et la TVA.
- Les clés de rapprochement sortent en `alpha`/`omega` mais l'attendu et les en-têtes utilisent `banque_alpha`/`banque_omega` → ajouter `key` canonique à `BankDataset`.
- Comptes collectifs détectables par les données : `plan_comptable.csv` a `compte_parent` → 3421/4411 sont parents de sous-comptes.
- Écriture déséquilibrée : `OD-2026-08-0142` (1 ligne, écart 850). Période verrouillée : `OD-2026-07-0093` (datée 2026-07-28 ≤ 2026-07-31, saisie le 19/08, sur 4411 sans tiers).
- Relevé Omega : totaux imprimés (16 324,81 débit) ≠ somme extraite (12 324,81) → écart 4 000 = troncature OCR de O03 (4 365,12 → 365,12, facture TE-5521 dans le GL).
- Virement interne : A13 (débit 50 000 Alpha) ↔ O02 (crédit 50 000 Omega), même date.
- TVA attendue : 55 000 collectée (reconstruction par encaissements, rejet A15↔A23 exclu, virement interne exclu, caution A25 hors champ, remise RCHQ-0831 non créditée exclue) ; déductible 46 283,49 + 2 900 immo. Data-only sans annotations : charges = 51 883,49 (IT-2026-0933 : 5 800 sur 34552), due = **3 116,51** ; avec annotation usage personnel 2 900 → due = **6 016,51** (l'écart Dell immo/charges et la NDF Hôtel 200 relèvent de l'étape 2).
- Espèces TE-5498 : 12 000 payé, plafond 5 000/jour/fournisseur (`parametres_fiscaux.tva.reglement_especes`) → TVA = 2 000 × 5 000/12 000 = 833,33.
- Écart de règlement ≤ 50 (extrait de `politique_cabinet.conventions_comptables.ecart_reglement` par regex `≤\s*(\d+)`) → facture soldée + TVA 10 % sur l'écart (`taux_par_nature.frais_bancaires`).
- GL August ACH entry for REG-2026-07-88120 exists (E-2026-08-0006) — les factures fournisseurs du mois se trouvent dans le GL (TTC = Σcrédits sur comptes fils de 4411, TVA = Σdébit 34552/34551) et dans `postes_ouverts_*.csv` pour les mois antérieurs.

---

### Task 1 — dataset.ts : chargement dynamique étendu

**Fichiers :**
- Modify: `agent cl/src/engine/dataset.ts`
- Test: `agent cl/tests/engine.test.ts`

**Interfaces produites :** `ClosingDataset` gagne `societe: JsonObject`, `openItems: Row[]`, `priorDeclarations: JsonObject` ; `BankDataset` gagne `key: string` (clé canonique de l'en-tête, ex. `banque_alpha`).

- [ ] **Étape 1 — test échouant** (ajouter dans `tests/engine.test.ts`) :

```ts
describe('dataset dynamique', () => {
  it('charge societe, postes ouverts, déclarations antérieures et clés bancaires canoniques', async () => {
    const ds = await loadClosingDataset(dataset, '2026-08');
    expect(String(ds.societe.derniere_periode_verrouillee?.fin)).toBe('2026-07-31');
    expect(ds.openItems.length).toBeGreaterThan(0);
    expect(ds.priorDeclarations).toHaveProperty('tva_2026-07');
    expect(ds.banks.map((b) => b.key)).toEqual(['banque_alpha', 'banque_omega']);
  });
});
```

- [ ] **Étape 2 — vérifier l'échec** : `npm test` (depuis `agent cl/`) → FAIL (propriétés absentes).
- [ ] **Étape 3 — implémentation** dans `dataset.ts` :
  - `headerForBank` retourne aussi la clé : `return { key, header }` ; `BankDataset = { name, key, rows, header }`.
  - Trier `bankPaths` par nom de fichier pour un ordre déterministe.
  - Charger `societe.json` (requis, trouvé par nom exact), `postes_ouverts_${previousEnd}.csv` (optionnel → `[]`), `declarations_et_rapprochements_anterieurs.json` (optionnel → `{}`).
- [ ] **Étape 4 — `npm test`** → PASS (les tests existants ne doivent pas régresser ; `closing_engine.ts` continue d'utiliser `bank.name`/`bank.header` qui restent présents).
- [ ] **Étape 5 — commit** : `git add -A && git commit -m "feat(engine): chargement dynamique societe, postes ouverts, declarations anterieures"`

### Task 2 — integrity.ts : contrôles du grand livre

**Fichiers :**
- Create: `agent cl/src/engine/integrity.ts`
- Test: `agent cl/tests/engine.test.ts`

**Interfaces produites :**

```ts
export type LedgerIssueType = 'ecriture_desequilibree' | 'periode_verrouillee' | 'compte_collectif';
export interface LedgerIssue { type: LedgerIssueType; ecriture_id?: string; piece?: string; compte?: string; date_ecriture?: string; ecart?: number; }
export function collectifAccounts(chart: Row[]): Set<string>;
export function checkLedgerIntegrity(ledger: Row[], chart: Row[], lockDate: string): LedgerIssue[];
```

**Règles :** ① équilibre par `ecriture_id` (Σdébit−Σcrédit au centime, ≠ 0 → issue avec `ecart`) ; ② `date_ecriture <= lockDate` (comparaison de chaînes ISO) ; ③ `compte ∈ collectifAccounts(chart)` = codes apparaissant comme `compte_parent` d'un autre compte. Lignes sans `ecriture_id` ignorées pour le contrôle d'équilibre. Une écriture équilibrée ne produit aucun issue.

- [ ] **Étape 1 — test échouant** (données d'exemple inline) :

```ts
describe('integrite du grand livre', () => {
  const chart = [
    { code: '3421', libelle: 'Clients', nature: 'ACTIF', lettrable: 'oui', compte_parent: '' },
    { code: '34210001', libelle: 'Clients — X', nature: 'ACTIF', lettrable: 'oui', compte_parent: '3421' },
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
```

- [ ] **Étape 2 — `npm test`** → FAIL (module inexistant).
- [ ] **Étape 3 — implémenter `integrity.ts`** (groupement par `ecriture_id` via `Map`, `collectifAccounts` = `new Set(chart.filter(r => r.compte_parent).map(r => r.compte_parent))`, arrondis via `money.ts`).
- [ ] **Étape 4 — `npm test`** → PASS.
- [ ] **Étape 5 — commit** : `git commit -m "feat(engine): controles d'integrite deterministes (equilibre, verrou, collectifs)"`

### Task 3 — bank_engine.ts : checksums, troncature OCR, virements internes

**Fichiers :**
- Rename: `agent cl/src/engine/bank.ts` → `agent cl/src/engine/bank_engine.ts` (git mv ; mettre à jour les imports : `src/engine/closing_engine.ts`, `tests/engine_calculations.test.ts`)
- Modify: `agent cl/src/engine/bank_engine.ts`
- Test: `agent cl/tests/engine.test.ts`

**Interfaces produites :**

```ts
export interface StatementChecksum { solde_initial: number; total_debit_extrait: number; total_credit_extrait: number; solde_final_calcule: number; solde_final_imprime: number; total_debit_imprime: number; total_credit_imprime: number; ecart_debit: number; ecart_credit: number; ecart_solde: number; coherent: boolean; }
export function verifyStatementChecksum(header: Record<string, unknown>, rows: Row[]): StatementChecksum;
export interface TruncationFinding { banque: string; id_ligne: string; piece: string; montant_extrait: number; montant_corrige: number; ecart: number; }
export function detectTruncations(bank: { key: string; rows: Row[] }, checksum: StatementChecksum, ledger: Row[]): TruncationFinding[];
export interface InternalTransfer { montant: number; date: string; source: { key: string; id_ligne: string }; cible: { key: string; id_ligne: string }; }
export function detectInternalTransfers(banks: { key: string; rows: Row[] }[]): InternalTransfer[];
```

**Algorithmes :**
- `verifyStatementChecksum` : `solde_final_calcule = solde_initial − Σdébits + Σcrédits` ; `coherent` = les 3 écarts (débit, crédit, solde) nuls au centime. Les champs manquants de l'en-tête valent 0.
- `detectTruncations` : si `ecart_debit ≠ 0` (ou `ecart_credit`), pour chaque ligne du sens correspondant on extrait une référence de pièce du libellé (regex générique `[A-Z]{2,4}-\d{2,4}-\d{3,5}`), on cherche dans le GL la facture (lignes même `piece` avec crédit sur un compte débutant par 4411) dont TTC = Σcrédits ; si `TTC − montant_ligne = écart` au centime → troncature confirmée, `montant_corrige = TTC`.
- `detectInternalTransfers` : paires (débit banque A, crédit banque B), même `date_operation`, même montant au centime, A ≠ B → virement interne.
- Conserver `matchBankEntries` (API existante) et `reconcileBank` inchangés dans le fichier renommé.

- [ ] **Étape 1 — tests échouants** :

```ts
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
});
```

- [ ] **Étape 2 — FAIL** ; **Étape 3 — implémenter + renommer les imports (git mv + mises à jour d'imports, aucun autre changement comportemental)** ; **Étape 4 — `npm test`** → PASS ; **Étape 5 — commit** : `feat(engine): checksums de releves, detection troncature OCR et virements internes`

### Task 4 — bank_engine.ts : suspens typés + appariement GL deux sens

**Fichiers :**
- Modify: `agent cl/src/engine/bank_engine.ts`
- Test: `agent cl/tests/engine.test.ts`

**Interfaces produites :**

```ts
export type SuspensType = 'frais_non_comptabilise' | 'impaye' | 'remise_non_creditee' | 'cheque_emis_non_debite' | 'encaissement_non_comptabilise' | 'non_categorise';
export interface SuspensItem { type: SuspensType; id_ligne?: string; ref?: string; libelle?: string; montant: number; date?: string; montant_corrige?: number; piece?: string; }
export interface LedgerMatchResult { matchedBank: string[]; suspens: SuspensItem[]; }
export function matchBankToLedger(bank: { key: string; rows: Row[] }, ledger: Row[], bankAccount: string): LedgerMatchResult;
```

**Algorithme :** ① rapprochement montant au centime + référence (colonne `ref_banque` du GL ↔ `id_ligne`, ou token commun) ; ② ligne banque débit non appariée → `frais_non_comptabilise` si libellé contient un token de frais (liste constante générique de langue : « frais », « commission », « tenue », « com »), ou `impaye` si appariée à un crédit antérieur (même montant au centime + token numérique ≥ 5 chiffres commun entre les deux libellés, crédit avant le débit), sinon `non_categorise` ; ③ mouvement GL sur le compte banque passé en paramètre sans ligne banque appariée (débit GL = `remise_non_creditee`, crédit GL = `cheque_emis_non_debite`) ; ④ crédit banque non apparié au GL → `encaissement_non_comptabilise`. Chaque suspens porte `id_ligne` ou `ref` (n° de pièce GL), `libelle`, `montant`, `date`.

- [ ] **Étape 1 — test échouant** : cas inline — 1 remise GL (débit 51411 9600) sans ligne banque → `remise_non_creditee` 9600 ; 1 chèque émis GL (crédit 51411 3120) sans ligne banque → `cheque_emis_non_debite` 3120 ; 1 débit banque libellé « FRAIS TENUE DE COMPTE » non apparié → `frais_non_comptabilise` ; 1 crédit banque puis débit banque de même montant avec même n° de chèque dans les deux libellés → `impaye`.
- [ ] **Étape 2 — FAIL** ; **Étape 3 — implémenter** ; **Étape 4 — `npm test`** → PASS ; **Étape 5 — commit** : `feat(engine): suspends bancaires types et appariement GL deux sens`

### Task 5 — vat_engine.ts : TVA au régime de l'encaissement

**Fichiers :**
- Rename: `agent cl/src/engine/vat.ts` → `agent cl/src/engine/vat_engine.ts` (git mv ; imports à mettre à jour : `src/engine/closing_engine.ts`, `tests/vat.test.ts`)
- Modify: `agent cl/src/engine/vat_engine.ts`
- Test: `agent cl/tests/engine.test.ts`

**Interfaces produites :**

```ts
export interface VatAnnotation { piece: string; tva_exclue: number; motif: string; }
export interface Imputation { banque?: string; id_ligne?: string; facture: string; tiers?: string; montant_impute: number; tva: number; statut: 'total' | 'partiel' | 'rejet' | 'virement_interne' | 'hors_champ' | 'non_imputable' | 'annotation_exclue'; }
export interface VatEncaissementResult extends VatResult { imputations_collectee: Imputation[]; imputations_deductible: Imputation[]; }
export function calculateVatEncaissement(input: {
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
}): VatEncaissementResult;
```

**Algorithmes (toutes les valeurs lues depuis les données) :**
- **Référentiel factures** : postes ouverts (`montant_ttc`, `dont_tva`, `tiers`, `piece`) + écritures GL fournisseurs/clients (TTC = Σcrédits sur comptes fils des collectifs clients/fournisseurs — comptes dont `compte_parent` ∈ {comptes parents des tiers} — , TVA = Σcrédit compte TVA collectée / Σdébit comptes TVA récupérables, classification par libellé comme l'existante `vatAccountTypes` de `closing_engine.ts`, à déplacer en helper partagé exporté depuis `vat_engine.ts`).
- **Collectée** : encaissements = crédits bancaires du mois (toutes lignes crédit des relevés, `date_operation` dans la période) − virements internes (transfers) − crédits rejettés (suspens `impaye`) ; imputation par référence de pièce extraite du libellé (regex générique `[A-Z]{2,4}-\d{2,4}-\d{3,5}`), sinon par tiers (`tiers.csv` : nom du tiers — tokens normalisés sans accents — présent dans le libellé) FIFO sur factures ouvertes du tiers ; écart ≤ seuil politique (regex `≤\s*(\d+)` sur `politique_cabinet.conventions_comptables.ecart_reglement`) → soldée, TVA pleine + TVA 10 % déductible sur l'écart (`fiscal.tva.taux_par_nature.frais_bancaires`) ; partiel → TVA = `dont_tva × imputé/TTC` au centime ; non imputable → `hors_champ` (TVA 0).
- **Déductible** : décaissements = débits bancaires (montants remplacés par `montant_corrige` des truncations) − virements internes + chèques émis (suspens `cheque_emis_non_debite`, date d'émission) + espèces (GL : écritures créditant le compte caisse lu dans `societe.caisse.compte`, pièce = référence facture) ; imputation facture par ref puis par tiers puis par montant exact ; facture payée intégralement → TVA pleine ; **espèces** : TVA = `tva_facture × min(TTC, plafond_journalier)/TTC_facture` (plafonds lus dans `fiscal.tva.reglement_especes.plafond_deductible_par_jour_et_fournisseur`) ; **non-déductible par compte** : libellés `fiscal.tva.non_deductible` → correspondance floue de tokens sur `plan_comptable.libelle` → ensemble de comptes exclus, factures dont une ligne de charge est sur un compte exclu → TVA exclue ; **annotations** : `tva_exclue` soustraite de la TVA de la pièce (statut `annotation_exclue`, motif conservé) ; classification charges vs immo selon le compte TVA de la facture (34552 → charges, 34551 → immobilisations).
- **due** = `max(0, collectée − charges − immo − crédit_antérieur)` ; `credit_anterieur` = report de la dernière déclaration TVA dans `priorDeclarations` si elle porte un crédit (0 par défaut) — pour cette étape, entrée `priorDeclarations` non fournie dans l'interface : `creditAnterieur?: number` paramètre optionnel additionnel (0 par défaut), le wiring des déclarations antérieures se fera à la tâche 6.
- `calculateVat` (méthode par comptes, existante) reste exportée pour les régimes ≠ encaissement.

- [ ] **Étape 1 — tests échouants** : cas inline — facture 12 000 TTC / 2 000 TVA payée en espèces 12 000 (plafond 5 000) → 833,33 ; partiel 14 000 sur facture 60 000 / 10 000 TVA → 2 333,33 ; annotation exclue (piece + tva_exclue soustraite) ; compte non-déductible (carburant) → TVA 0 ; écart ≤ seuil → TVA pleine + TVA de l'écart ; plus test de non-régression sur `tests/vat.test.ts` (import mis à jour, sémantique inchangée).
- [ ] **Étape 2 — FAIL** ; **Étape 3 — implémenter** ; **Étape 4 — `npm test`** → PASS ; **Étape 5 — commit** : `feat(engine): tva encaissement deterministe avec lettrage, prorata especes et annotations`

### Task 6 — closing_engine.ts : coordination + contrat + intégration

**Fichiers :**
- Modify: `agent cl/src/engine/closing_engine.ts`
- Modify: `agent cl/src/contracts/output.ts` (ajouter `corrections_candidates: z.array(z.record(z.unknown())).optional()` à `BankReconciliationSchema`)
- Test: `agent cl/tests/engine.test.ts` (remplacer les 2 tests d'intégration existants)

**Interfaces produites :** `Output.rapprochements` clés par `bank.key` (`banque_alpha`…) ; anomalies générées depuis `LedgerIssue[]`, `TruncationFinding[]`, `InternalTransfer[]`, `SuspensItem[]`.

**Assemblage dans `run()` :**
1. `checkLedgerIntegrity(ledger, chart, String(societe.derniere_periode_verrouillee?.fin ?? ''))` → anomalies (`ecriture_desequilibree` → gravite bloquante ; `periode_verrouillee` → bloquante ; `compte_collectif` → haute) avec preuves `GL:{piece}`.
2. Par banque : `verifyStatementChecksum` (incohérence → anomalie) ; `detectTruncations` (→ anomalie « extraction tronquée » avec montant corrigé) ; `matchBankToLedger` → suspens.
3. `detectInternalTransfers` → anomalie « virement interne à comptabiliser via virements de fonds » (preuves `BQ:{key}:{id}` des deux côtés).
4. TVA : `régime = fiscal.tva.regime_dossier` → `calculateVatEncaissement` si `encaissement` (en passant `creditAnterieur` depuis les déclarations antérieures si un crédit y figure), sinon `calculateVat` existant. Supprimer l'anomalie générique « TVA à l'encaissement partiellement résolue ».
5. Rapprochements : clés `bank.key` ; `solde_gl_apres = solde_gl_avant` (pas de propositions à l'étape 1) ; `corrections_candidates` = suspens actionnables (frais, impayé, troncature) ; suspens typés ; `controle_totaux_imprimes` = checksum sérialisé (champs du `StatementChecksum`).
6. Conserver : `missingEvidenceAnomalies`, dotation immobilisations, écart de rapprochement. Supprimer `unresolvedBankAnomalies` (remplacé par les suspens typés). Si `reconcileBank` et `matchBankEntries` ne sont plus utilisés par `closing_engine`, `matchBankEntries` reste (testé par `tests/engine_calculations.test.ts`) ; `reconcileBank` peut être supprimé si plus aucune référence n'existe.
7. Le premier test d'intégration existant (propositions 0, schema valide, pas de 'Atlas Négoce'/'P-01') reste valable SAUF l'assertion `item.titre.includes('TVA')` qui disparaît avec l'anomalie générique supprimée — la retirer.

- [ ] **Étape 1 — tests d'intégration (dataset réel comme fixture — valeurs dérivées des données, jamais du code) :**

```ts
describe('integration atlas (fixture)', () => {
  const run = () => new ClosingEngine(dataset, '2026-08').run();
  it('reconstruit la tva encaissement depuis les donnees', async () => {
    const output = await run();
    expect(output.tva.tva_collectee_exigible).toBe(55000);
    expect(output.tva.tva_deductible_charges).toBe(51883.49);   // data-only, IT-2026-0933 entier sur 34552 ; Hôtel NDF 200 = proposition P-36 (étape 2), hors entrées du moteur
    expect(output.tva.tva_due).toBe(3116.51);
  });
  it('clee les rapprochements par les cles canoniques et typpe les suspens', async () => {
    const output = await run();
    expect(Object.keys(output.rapprochements)).toEqual(['banque_alpha', 'banque_omega']);
    const alpha = JSON.stringify(output.rapprochements.banque_alpha.suspens);
    expect(alpha).toContain('remise_non_creditee'); expect(alpha).toContain('cheque_emis_non_debite');
    expect(output.rapprochements.banque_omega.controle_totaux_imprimes?.ecart).toBe(4000);
  });
  it('emets les anomalies d integrite attendues depuis les donnees', async () => {
    const output = await run();
    const text = JSON.stringify(output.anomalies);
    expect(text).toContain('desequilibree'); expect(text).toContain('verrouillee'); expect(text).toContain('collectif');
    expect(text).toContain('tronquee'); expect(text).toContain('virement interne');
  });
});
```

- [ ] **Étape 2 — FAIL** ; **Étape 3 — implémenter la coordination + contrat** ; **Étape 4 — vérification complète :** `npm test` (tous les tests, anciens + nouveaux), `npm run typecheck`, puis `$env:LLM_PROVIDER='deterministic'; npm run cloture -- --dossier atlas_negoce --periode 2026-08` et vérifier `sortie_agent/tva.json` (due 3 116,51) et `rapprochements.json` (clés `banque_*`) ; **Étape 5 — commit** : `feat(engine): coordination moteur deterministe et structures exploitables par les outils`

---

## Auto-revue du plan

- **Couverture du prompt :** dataset dynamique ✓ (T1, aucun chemin/nom en dur — tous les `findFile` restent par motifs), intégrité 3 contrôles ✓ (T2), checksums + troncature + 5115 ✓ (T3-T4), TVA encaissement avec espèces/non-déductible ✓ (T5), coordination + zéro arithmétique LLM ✓ (T6), tests dans `tests/engine.test.ts` ✓.
- **Cohérence de types :** `InternalTransfer`/`TruncationFinding`/`SuspensItem` définis en T3-T4, consommés en T5-T6 avec signatures identiques ; `VatResult` inchangé (compatibilité `TvaSchema` zod).
- **Risques assumés :** TVA data-only ≠ attendu sur le split charges/immo (Dell/MacBook → étape 2, test documente 3 116,51 vs 6 016,51 après annotation) ; NDF Hôtel 200 hors entrées moteur (proposition P-36, étape 2) ; imputation par nom de tiers = heuristique documentée (tokens normalisés sans accents).
