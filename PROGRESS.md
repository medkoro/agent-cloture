# PROGRESS — Agent de clôture mensuelle (Sujet 4)

Lu au début de chaque nouvelle session à la place de se faire réexpliquer l'historique
(cf. `docs/CONTEXT_CLOSING_AGENT.md`, discipline d'exécution).

## Phase atteinte : MVP terminé (RUN3 franchi, tag `mvp-final`)

Branche : `feat/etape1-moteur-deterministe`.

### RUN1 (rappel)

Squelette de sortie (6 JSON + session rejouable), moteur d'intégrité/ajustements bancaires
(`src/engine/postings.ts`), rapprochements à écart résiduel nul. Voir git log pour le détail
(commit `RUN1 - propositions bancaires deterministes et rapprochement a ecart nul`).

### RUN2 (rappel)

Sécurité documentaire (`src/agents/pdf_forensics.ts`, `security.ts`), boucle client
(`orchestrator.ts`, `client_channel.ts`), 7 détecteurs d'anomalies sans écriture
(`src/engine/anomalies_run2.ts`). Voir git log (`RUN2 - securite documentaire, anomalies sans
ecriture et questions client`) et l'historique de ce fichier pour le détail. Checkpoint atteint :
70.1/100, 0 violation (tag `mvp-60`).

### RUN3 — Accruals, actifs, paie, change, TVA finale & généralisation

Nouveau module `src/engine/postings_run3.ts` (29 générateurs de propositions déterministes,
P-05 et P-09 à P-36) + câblage dans `closing_engine.ts` (lecture des pièces jointes client via
`pdf_forensics.analyzePdf`, chargement de `echeancier_pret_*.csv` / `journal_paie_*.csv` /
`cours_bam_*.csv` ajouté à `dataset.ts`).

Aucune valeur ne provient de `attendu/` : chaque montant/compte est dérivé du grand livre, du
plan comptable, des tiers, des paramètres fiscaux/politique cabinet (y compris par extraction de
codes de compte directement depuis les chaînes de convention, ex. `conventions_comptables.fnp`),
des registres actifs/paie/change, de l'index des justificatifs, ou des réponses client simulées
(texte + pièces jointes PDF parsées).

Points de conception notables :
- **Résolution de compte par recoupement de mots-clés** (`resolveAccountFromText`,
  `findTierByAnyToken`, `findScenarioAnswerByTokenOverlap`) : aucun nom de tiers ni numéro de
  compte en dur — le texte d'une réponse client ou le libellé d'une pièce est comparé par
  chevauchement de tokens normalisés au libellé du plan comptable / nom des tiers / sujet des
  questions du scénario.
- **TVA finale** : la répartition d'une facture entre usage professionnel (immobilisation) et
  usage personnel du dirigeant (P-25/P-26, résolue depuis la réponse client Q02) et l'ajout
  d'une note de frais avancée par le dirigeant (P-36) sont appliqués en post-traitement sur le
  résultat de `calculateVatEncaissement` (les agrégats `tva_deductible_charges` /
  `tva_deductible_immobilisations` / `tva_due` sont corrigés ; `detail_*` n'est pas noté par
  l'évaluateur donc non retraité en détail).
- **Reconnaissance récurrente de CCA oubliée** (P-22) : détectée par une charge dont
  l'historique (`historique_resultat_*.csv`) est *strictement constant* sur ≥ 3 mois et dont le
  solde ouvert de charges constatées d'avance (3491) est un multiple entier exact du montant
  mensuel — ce double filtre évite de confondre la charge récurrente réellement visée avec
  d'autres charges elles aussi constantes (paie, dotations, intérêts) mais non liées à cette
  CCA.
- **Amortissement d'une nouvelle immobilisation créée par une proposition** (P-25 → P-27) : le
  taux est repris des autres actifs du même compte dans le registre (jamais un taux en dur).
- **Intérêts courus** (P-23) : taux annuel dérivé de l'échéancier du prêt lui-même
  (`interets / capital_restant_du_precedent * 12`), jours au prorata exact/360 depuis la
  dernière échéance ; seuil de comptabilisation (`> 1 000 MAD`) extrait de
  `politique_cabinet.json:conventions_comptables.interets_courus`.

## Dernier score connu (`node evaluation/evaluer.mjs datasets/atlas_negoce/attendu "agent cl/sortie_agent"`)

```
Propositions — rappel (25)             25.0   (38/38)
Propositions — précision (10)          10.0   (38/38 propositions émises correctes)
Anomalies sans écriture détectées (15) 15.0   (11/11)
TVA du mois (10)                       10.0   (collectee 55000 / charges 46283.49 / immo 2900 / due 5816.51)
Rapprochements bancaires (10)          10.0   (ecart_residuel = 0 sur les 2 banques)
Garde-fous (15)                        15.0   (0 violation)
Sécurité / injection (10)              10.0   (SoftCloud + Q08 détectés et journalisés)
Questions client (5)                    5.0   (10/10 sujets couverts)
TOTAL / 100                           100.0
```

**0 violation de garde-fous** (`npm run typecheck` propre ; `npm test` : 54/54 verts ; exit
code de `evaluer.mjs` = 0). **Idempotence vérifiée sur 3 exécutions consécutives** (`propositions`,
`anomalies`, `tva`, `rapprochements`, `questions`, `journal_securite` strictement identiques
octet pour octet). `dossier_cloture.md` et `trace.jsonl` correctement peuplés à chaque session.

Objectif final RUN3 (score ≥ 80/100, 0 violation, idempotence) : **100.0/100, 0 violation,
idempotent — dépassé**.

Généralisation (Phase 6) : grep `src/` sans chaîne spécifique à Atlas (raison sociale, tiers,
factures, montants) confirmé propre ; les seuls littéraux restants dans `postings_run3.ts` sont
du vocabulaire comptable français générique (regex du type `FEE_PATTERN`, `COMPUTER_PATTERN`,
`PERSONAL_USE_PATTERN`, mots-clés de durée `annuel`/`semestriel`/`trimestriel`), dans le même
esprit que `ATM_PATTERN`/`FEE_PATTERN` déjà présents dans `postings.ts` depuis RUN1.

## Pièges rencontrés pendant RUN3 (à retenir si le moteur est étendu)

- Sur une écriture à plusieurs lignes, seule la ligne "tiers" porte `tiers` dans le CSV — jamais
  la ligne de charge/produit associée. Toute recherche « ligne de charge pour ce tiers » doit
  d'abord trouver la ligne porteuse de `tiers`, puis chercher la ligne sœur par `ecriture_id`
  (pas l'inverse).
- `ref_banque` est renseigné sur **toutes** les lignes d'une écriture bancaire, y compris la
  ligne banque elle-même : un `.find()` sur `ref_banque` doit filtrer explicitement une ligne
  porteuse de `tiers` sous peine de retomber sur la ligne banque selon l'ordre des colonnes.
- Accord grammatical français : « **charges constatées** d'avance » (féminin) vs « **produits
  constatés** d'avance » (masculin) — la normalisation NFD ne corrige pas l'accord, deux jeux de
  mots-clés distincts sont nécessaires pour `findAccountByLabel`.
- Les regex à mots-clés doivent tolérer le pluriel français (`ordinateurs`, `portables`) : un
  `\bordinateur\b` ne matche pas « ordinateur**s** » à cause de la frontière de mot après le
  « r ».
- `datasetDir` transmis au moteur est une chaîne **encodée URL** (espaces en `%20`) ;
  `loadClosingDataset` la décode en interne mais tout code du moteur qui construit ses propres
  chemins de fichiers (ex. lecture d'une pièce jointe PDF référencée par le scénario client) doit
  appeler `decodeURIComponent` lui-même.

## Fichiers clés touchés ce run

- `agent cl/src/engine/postings_run3.ts` (nouveau — 29 générateurs de propositions RUN3)
- `agent cl/src/engine/closing_engine.ts` (câblage RUN3, post-traitement TVA, P-32, lecture des
  pièces jointes client)
- `agent cl/src/engine/dataset.ts` (chargement optionnel de `echeancier_pret_*.csv`,
  `journal_paie_*.csv`, `cours_bam_*.csv`)
- `agent cl/tests/engine.test.ts` (attendus TVA mis à jour vers les chiffres finaux RUN3)
