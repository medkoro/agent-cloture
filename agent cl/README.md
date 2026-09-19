# Agent de clôture mensuelle

Prototype de référence du sujet 4 : moteur déterministe CGNC, sécurité, approbation humaine, API NestJS, persistance MySQL, jobs Redis/BullMQ et cockpit React.

## Installation

```bash
npm install
```

## Génération

```bash
npm run cloture -- --dossier atlas_negoce --periode 2026-08
```

La commande produit les six fichiers JSON dans `sortie_agent/` et bloque toute sortie qui viole les garde-fous.

## API et cockpit

```bash
npm run start
npm run web:install
npm run web:build
cd web && npm run dev
```

L’API expose `GET /api/clotures`, `POST /api/clotures` et l’approbation protégée `POST /api/clotures/:id/propositions/:propositionId/approve`.

En environnement Docker, `docker-compose up` démarre MySQL, Redis et l’API. Le stockage utilise MySQL si `MYSQL_HOST` est configuré, sinon un stockage mémoire local est utilisé pour les tests.

Chaque session génère `sessions/<id>/dossier_cloture.md`, `trace.jsonl` et une copie de `sortie_agent/`. Les événements de trace sont JSONL et rejouables.

## Évaluation

```bash
npm run eval
```

Le moteur déterministe calcule les montants ; les documents et réponses client sont analysés comme des données non fiables.

## LLM

Sans configuration, `LLM_PROVIDER=deterministic` exécute une boucle agentique reproductible avec tool calling simulé. Pour Azure OpenAI, renseignez `LLM_PROVIDER=azure-openai`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` et `AZURE_OPENAI_DEPLOYMENT` dans `.env`. Le LLM planifie et appelle les outils ; il ne calcule jamais les montants.
