# RUN 1 — Fondations, Rapprochements Bancaires & TVA de Base

Lis d'abord `GUARDRAILS.md` (mission, objectif, les 10 guardrails absolus, scope, discipline d'exécution) — applique-le strictement pour ce run. Lis aussi CONTEXT_CLOSING_AGENT.md et CLAUDE.md du repo.

Crée un fichier `PROGRESS.md` à la racine du repo si absent, et mets-le à jour à la fin de ce run avec : phase atteinte, dernier score/violations connus, TODO restant pour RUN2.

## Objectif de ce run
Établir des squelettes de sortie valides, résoudre les ajustements comptables liés à la banque, et atteindre un écart résiduel nul sur les rapprochements bancaires.

## Phase 0 — Squelette de sortie
- Câble `src/cli/run_cloture.ts` pour écrire le répertoire complet `sortie_agent/` : `propositions.json`, `anomalies.json`, `tva.json`, `rapprochements.json`, `questions.json`, `journal_securite.json`, plus `sessions/<id>/dossier_cloture.md` et `trace.jsonl`.
- Pour les composants pas encore implémentés, écris des structures valides conformes Zod et vides (tableaux `[]`).
- Impose le validateur de guardrails (`src/guardrails/validator.ts`) comme porte obligatoire avant l'écriture de toute proposition.

## Phase 2 — Intégrité & Ajustements Bancaires (P-01 à P-08)
Depuis `integrity.ts` et `bank_engine.ts`, génère :
- **P-01** : type "complement" pour équilibrer l'écriture à sens unique OD-2026-08-0142 (crédit fournisseur auxiliaire 44110013, 850.00 MAD, sans TVA).
- **P-02** : Contre-passation pour facture fournisseur dupliquée (débit fournisseur 4411xxxx, crédit 6111, crédit 34552).
- **P-03** : Correction de troncature relevé Omega (delta checksum imprimé O03 de 4 000.00 MAD : débit fournisseur 4411xxxx 4 000.00 / crédit 51412 4 000.00).
- **P-04A, P-04B, P-04C** : Frais bancaires débités non comptabilisés, répartis HT (débit 6147) + TVA 10% (débit 34552) / crédit banque (51411/51412).
- **P-06** : Extourne chèque client impayé (débit client auxiliaire 3421xxxx 24 000.00 / crédit 51411 24 000.00). Exclure de la TVA collectée.
- **P-07** : Reclassification virement bancaire interne mal affecté en produit (débit 7111 50 000.00 / crédit 5115 50 000.00).
- **P-08** : Reclassification retrait DAB espèces posté en charge (débit caisse 5161 5 000.00 / crédit 61431 5 000.00).

Violation période verrouillée (OD-2026-07-0093) : **aucune correction comptable**. Escalade en anomalie expert (statut : bloquee).

Mets à jour `rapprochements.json` : calcule `solde_gl_apres = solde_gl_avant + sum(ajustements en centimes)`. Intègre les chèques en transit documentés (dépôt non crédité 9 600.00 MAD, chèque non débité 3 120.00 MAD). Assure `ecart_residuel === 0` pour banque_alpha et banque_omega. Inclus `controle_totaux_imprimes`.

## Phase 3 — Extraction TVA de base
- Sors `tva.json` via `vat_engine.ts` (régime : "encaissement").
- Remplis `detail_collectee` et `detail_deductible` avec preuves exactes. L'écart de référence de l'étape 1 se comblera au RUN3 avec les propositions actifs/charges.

## STOP RUN 1 ICI
Exécute :
```
npm run typecheck
npm test
npm run cloture -- --dossier datasets/atlas_negoce --periode 2026-08 --sortie sortie_agent/
node evaluation/evaluer.mjs datasets/atlas_negoce/attendu sortie_agent/
```
Vérifie 0 violation de guardrail. Mets à jour `PROGRESS.md`. Commit ("RUN1 complete").
