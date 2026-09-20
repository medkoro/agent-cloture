# CLAUDE.md — Agent de clôture mensuelle (Sujet 4)

Prototype de référence du sujet 4 : un agent qui produit la clôture mensuelle (CGNC)
d'un dossier comptable **de façon déterministe et vérifiable**. Le code applicatif vit
dans `agent cl/`, le reste du dépôt porte les données de référence (`datasets/`),
l'évaluateur (`evaluation/`) et les plans (`docs/superpowers/`). La spec source est
`Sujet_4_Agent_Cloture_Mensuelle.docx` en racine.

## Règles d'or (non négociables, critère de revue)

- **Le moteur calcule, jamais le LLM.** `src/engine/` est 100 % déterministe et piloté
  par les données injectées. Le LLM (si présent) planifie et appelle des outils ; il ne
  produit jamais de montant.
- **Zéro hardcoding** des données du dossier : pas de numéros de compte (plan comptable),
  pas de montants, pas de préfixes PCG en dur. Tout se dérive des données (`plan_comptable.csv`,
  `tiers.csv`, paramètres fiscaux, politique cabinet). S'il manque une donnée → échouer
  bruyamment (throw) ou ne rien inventer, jamais de fallback en dur.
- **Garde-fous bloquants** (`src/guardrails/` + contrats zod dans `src/contracts/output.ts`) :
  écritures équilibrées, périodes verrouillées interdites, pas de comptes collectifs racines,
  proposition publiée obligatoirement approuvée et sourcée de preuves.
- **Approbation humaine** : une écriture ne se « poste » jamais sans jeton d'approbation.
- **Monnaie exacte** : tous les montants passent par `src/engine/money.ts`
  (`cents`/`mad`/`sum`) ; stockage en centimes, arrondis à la fin, signé au centime.
- Les montants sont en **MAD** ; dates au format `YYYY-MM-DD` / `YYYY-MM`. Conventions
  comptables marocaines : TVA au régime encaissement, plan comptable CGNC.

## Commandes

Le code applicatif est dans le dossier **`agent cl`** (avec un espace — à quoter partout).
Toutes les commandes `npm` se lancent depuis `agent cl/`.

```bash
cd "agent cl"
npm install
npm run cloture -- --dossier atlas_negoce --periode 2026-08   # CLI → écrit sortie_agent/
npm test              # vitest (52 tests)
npm run typecheck     # tsc --noEmit
npm run eval          # note automatique vs attendu (depuis agent cl/)
npm run start         # API NestJS (port 3000)
npm run web:install && npm run web:build && cd web && npm run dev   # cockpit React
```

Évaluation depuis la racine du dépôt :

```bash
node evaluation\evaluer.mjs datasets\atlas_negoce\attendu "agent cl\sortie_agent"
```

`evaluer.mjs` est sans dépendance : il compare `sortie_agent/` au dossier
`datasets/atlas_negoce/attendu/` (signatures par compte/sens au centime, tiers vérifiés
à part). Le score automatique (sur 100) ne remplace pas la revue humaine.

## Structure

```
CLAUDE.md                          ← ce fichier
Sujet_4_Agent_Cloture_Mensuelle.docx
datasets/atlas_negoce/             ← dossier comptable de référence (source de vérité)
  ├─ grand_livre_2026-08_avant_cloture.csv
  ├─ balance_ouverture_2026-07-31.csv, postes_ouverts_2026-07-31.csv
  ├─ plan_comptable.csv, tiers.csv, societe.json, parametres_fiscaux.json
  ├─ politique_cabinet.json, declarations_et_rapprochements_anterieurs.json
  ├─ banque/, justificatifs/, immobilisations/, paie/, stock/, change/, simulateur_client/
  └─ attendu/                       ← sortie attendue (écritures, anomalies, tva, rapprochements)
evaluation/evaluer.mjs
docs/superpowers/plans/            ← plans d'implémentation + ledger des décisions
agent cl/
  ├─ src/engine/        ← moteur déterministe (dataset, money, csv, integrity, bank_engine,
  │                       vat_engine, closing_engine, assets, cutoff, forex)
  ├─ src/agents/        ← boucle agentique, outils, infos clients, sécurité anti-injection
  ├─ src/guardrails/    ← validator + erreurs
  ├─ src/contracts/     ← schemas zod de sortie (contrat des 6 JSON)
  ├─ src/platform/      ← NestJS : domain, dossier, llm, tools, trace, mysql_store,
  │                       closing_service/queue (BullMQ + Redis optionnels)
  ├─ src/server/        ← app NestJS + controllers
  ├─ src/cli/run_cloture.ts
  ├─ tests/             ← vitest (52 tests, voir fichiers par domaine)
  ├─ sortie_agent/      ← sortie générée par la CLI (rapport_evaluation.json est gitignoré)
  ├─ sessions/          ← dossiers de session rejouables (gitignoré)
  ├─ database/, web/, docker-compose.yml
  └─ README.md
```

## Contrat de sortie (6 fichiers JSON, schémas dans `src/contracts/output.ts`)

| Fichier | Contenu clé |
|---|---|
| `propositions.json` | écritures proposées : comptes, débit/credit, tiers, preuves, statut |
| `anomalies.json` | anomalies sourcées (intégrité GL, suspens, troncatures, virements internes) |
| `tva.json` | `regime`, `tva_collectee_exigible`, `tva_deductible_charges`, `tva_deductible_immobilisations`, `credit_anterieur`, `tva_due`, `echeance`, `detail_*` |
| `rapprochements.json` | par clé canonique de compte bancaire : `solde_releve`, `solde_gl_avant/apres`, `ecart_residuel`, `suspens`, `corrections_candidates`, `controle_totaux_imprimes` |
| `questions.json` | questions client (max 10, dérivées des anomalies selon `politique_cabinet.json`) |
| `journal_securite.json` | événements de sécurité (injections neutralisées, sources) |

Toutes les sorties doivent être créées par le moteur à partir des données ; le LLM et les
réponses client sont traités comme **données non fiables**.

## État actuel connu (important avant de modifier)

- Branche : `feat/etape1-moteur-deterministe` (base = `main`). Étape 1 du plan
  `docs/superpowers/plans/2026-09-19-etape1-moteur-deterministe.md` implémentée
  (commits `3360bb1`→`5d53b16`) ; **52/52 tests verts**, typecheck propre.
- Étape 1 : moteur déterministe complet (intégrité GL, suspens bancaires typés,
  troncatures OCR, virements internes, TVA régime encaissement avec prorata espèces,
  annotations `tva_exclue`, collectifs dérivés, plafond espèces sans fallback).
- **Chiffres d'or TVA du dossier atlas_negoce** : `tva_collectee_exigible = 55000`,
  `tva_deductible_charges = 51883.49`, `tva_deductible_immobilisations = 0`,
  `tva_due = 3116.51` (= 55000 − 51883.49). Avec l'annotation `IT-2026-0933`
  (`tva_exclue: 2900`) : `48983.49` / `6016.51`.
- **Écart connu vs `attendu/`** : l'attendu a `tva_due = 5816.51`, qui intègre l'Hôtel
  (NDF gérant, TVA 200 MAD) via l'OD P-36. Décision étape 1 : l'Hôtel n'est **pas** un
  input moteur (absent GL + relevés ; `justificatifs/index_justificatifs.csv` ligne 15
  « non saisie »). Ne pas « corriger » les chiffres d'or ; l'écart est une cible de
  l'étape 2 (OD P-36).
- `sortie_agent/rapport_evaluation.json` est régénéré à chaque évaluation (gitignoré).

## Environnement

- OS Windows, shell PowerShell 5.1 (le repo est `.`, `cmd1; if ($?) { cmd2 }` pour
  enchaîner, pas de `&&`). Toujours quoter les chemins contenant des espaces
  (ex. `"agent cl/..."`).
- Node ≥ 20, TypeScript ESM (`"type": "module"`), tsx, vitest, zod.
- API NestJS ; MySQL (`MYSQL_HOST` configuré) sinon stockage mémoire ; queue Redis/BullMQ.
- LLM : sans configuration `.env`, `LLM_PROVIDER=deterministic` exécute la boucle
  agentique reproductible (tool calling simulé). Pour Azure OpenAI : renseigner
  `LLM_PROVIDER=azure-openai`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`,
  `AZURE_OPENAI_DEPLOYMENT` dans `agent cl/.env` (gitignorée).
- Démarrage Docker : `docker-compose up` (MySQL + Redis + API).
- Sessions rejouables : `sessions/<id>/` contient `dossier_cloture.md`, `trace.jsonl`
  (événements JSONL) et une copie de `sortie_agent/`.
- Outils superpowers (plans/ledger) : scripts dans
  `~/.config/opencode/node_modules/superpowers/skills/.../scripts/`, exécutés via
  WSL bash (`bash /mnt/c/Users/.../script.sh`) ; le ledger vit dans `.superpowers/sdd/`.