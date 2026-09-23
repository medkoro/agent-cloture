# Agent de clôture mensuelle — Sujet 4

Prototype de référence pour un agent qui produit la **clôture mensuelle CGNC**
(Code Général de la Normalisation Comptable, référentiel marocain) d'un dossier
comptable de façon **déterministe et vérifiable**.

Le moteur de calcul est 100 % déterministe et piloté par les données du dossier ;
un LLM (optionnel) orchestre la boucle agentique (planification, appel d'outils)
mais **ne calcule jamais un montant**. Toute proposition d'écriture doit être
sourcée, garde-fouée et approuvée par un humain avant d'être postée.

## Le problème

Chaque mois, un cabinet comptable doit clôturer un dossier client : rapprocher
les relevés bancaires, calculer la TVA (régime encaissement au Maroc), détecter
les anomalies (suspens, troncatures OCR, virements internes, comptes collectifs
non soldés), passer les écritures de régularisation (charges/produits à
recevoir, amortissements, stock, change, paie...) et poser les bonnes questions
au client. Cet agent automatise ce travail tout en gardant un humain dans la
boucle pour l'approbation finale, avec une garantie de zéro hardcoding : aucun
numéro de compte, montant, ou seuil n'est écrit en dur dans le code — tout est
dérivé des données injectées (plan comptable, tiers, paramètres fiscaux,
politique cabinet).

## Règles d'or

- **Le moteur calcule, jamais le LLM.** `agent cl/src/engine/` est 100 %
  déterministe. Le LLM planifie et appelle des outils ; il ne produit jamais un
  montant.
- **Zéro hardcoding** des données du dossier (comptes, montants, préfixes PCG).
  Tout se dérive de `plan_comptable.csv`, `tiers.csv`, des paramètres fiscaux et
  de la politique cabinet. Donnée manquante → échec explicite, jamais de
  fallback inventé.
- **Garde-fous bloquants** : écritures équilibrées, périodes verrouillées
  interdites, pas de comptes collectifs racines, proposition publiée
  obligatoirement approuvée et sourcée de preuves.
- **Approbation humaine** obligatoire avant qu'une écriture ne soit postée.
- **Monnaie exacte** : tous les montants passent par `money.ts`
  (`cents`/`mad`/`sum`), stockage en centimes, arrondi uniquement à la fin.
- Montants en **MAD**, dates `YYYY-MM-DD` / `YYYY-MM`, TVA au régime
  encaissement, plan comptable CGNC.

## Structure du dépôt

```
README.md                          ← ce fichier (vue d'ensemble du projet)
CLAUDE.md                          ← règles d'or et contexte détaillé pour l'agent de dev
Sujet_4_Agent_Cloture_Mensuelle.docx  ← spec source du sujet
datasets/atlas_negoce/             ← dossier comptable de référence (source de vérité)
  ├─ grand_livre_2026-08_avant_cloture.csv, balance_ouverture_2026-07-31.csv
  ├─ plan_comptable.csv, tiers.csv, societe.json, parametres_fiscaux.json
  ├─ politique_cabinet.json, declarations_et_rapprochements_anterieurs.json
  ├─ banque/, justificatifs/, immobilisations/, paie/, stock/, change/, simulateur_client/
  └─ attendu/                      ← sortie attendue (écritures, anomalies, TVA, rapprochements)
evaluation/evaluer.mjs             ← évaluateur sans dépendance (note /100)
docs/superpowers/plans/            ← plans d'implémentation et ledger des décisions
agent cl/                          ← code applicatif (dossier avec un espace dans le nom)
  ├─ src/engine/      ← moteur déterministe (intégrité, banque, TVA, clôture, actifs, cut-off, change)
  ├─ src/agents/       ← boucle agentique, outils, sécurité anti-injection
  ├─ src/guardrails/   ← validateur + erreurs bloquantes
  ├─ src/contracts/    ← schémas zod des 6 fichiers de sortie
  ├─ src/platform/     ← API NestJS : domaine, dossier, LLM, outils, trace, MySQL, queue BullMQ/Redis
  ├─ src/cli/          ← CLI `run_cloture.ts`
  ├─ tests/            ← suite vitest
  ├─ web/               ← cockpit React
  └─ README.md         ← détails d'installation et de commandes de l'app
```

## Démarrage rapide

Le code applicatif est dans **`agent cl`** (avec un espace — à toujours quoter).

```bash
cd "agent cl"
npm install
npm run cloture -- --dossier atlas_negoce --periode 2026-08   # écrit sortie_agent/
npm test              # suite vitest
npm run typecheck      # tsc --noEmit
npm run eval           # note automatique vs attendu
npm run start           # API NestJS (port 3000)
```

Sans configuration `.env`, `LLM_PROVIDER=deterministic` exécute la boucle
agentique de façon reproductible (aucun appel réseau requis). Voir
`agent cl/README.md` pour la configuration Azure OpenAI ou Ollama, l'API, le
cockpit React et Docker.

Évaluation depuis la racine du dépôt :

```bash
node evaluation/evaluer.mjs datasets/atlas_negoce/attendu "agent cl/sortie_agent"
```

`evaluer.mjs` compare `sortie_agent/` au dossier `datasets/atlas_negoce/attendu/`
(signatures par compte/sens au centime, tiers vérifiés à part). Le score
automatique (sur 100) ne remplace pas la revue humaine.

## Contrat de sortie

L'agent produit 6 fichiers JSON validés par des schémas zod
(`agent cl/src/contracts/output.ts`) :

| Fichier | Contenu clé |
|---|---|
| `propositions.json` | écritures proposées : comptes, débit/crédit, tiers, preuves, statut |
| `anomalies.json` | anomalies sourcées (intégrité GL, suspens, troncatures, virements internes) |
| `tva.json` | régime, TVA collectée/déductible, crédit antérieur, TVA due, échéance |
| `rapprochements.json` | par compte bancaire : solde relevé/GL, écart résiduel, suspens |
| `questions.json` | questions client (max 10, dérivées des anomalies) |
| `journal_securite.json` | événements de sécurité (injections neutralisées, sources) |

Le LLM et les réponses client sont toujours traités comme des **données non
fiables** ; seul le moteur, à partir des données du dossier, produit ces sorties.

## État actuel

- Score `evaluer.mjs` : **100/100** sur le dossier `atlas_negoce` (période
  2026-08) — 38/38 propositions, 11/11 anomalies, 10/10 questions, 0 violation
  de garde-fous.
- Suite de tests : **54/54** vitest verts, typecheck propre.
- Historique git organisé en 3 jalons progressifs (RUN1 → RUN2 `mvp-60` →
  RUN3 `mvp-final`), voir `git log --oneline`.

Voir `CLAUDE.md` pour le détail des règles de contribution, l'environnement
(Windows/PowerShell), et les chiffres d'or de référence du dossier
`atlas_negoce`.
