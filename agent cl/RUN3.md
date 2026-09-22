# RUN 3 — Accruals, Paie, TVA Finale & Généralisation (CIBLE >= 80)

Lis d'abord `GUARDRAILS.md` et `PROGRESS.md` (mis à jour au RUN2, tag `mvp-60`) — ne redemande pas l'historique.

## Objectif de ce run
Implémenter les propositions comptables restantes (P-09 à P-36), verrouiller la TVA à 5 816.51 MAD, et éliminer le sur-ajustement (overfitting).

## Phase 5 — Propositions Accruals, Actifs, Paie & Clôture
- **P-09 & P-10** : Reclassification remboursement de dépôt (4497 vers 2486, 7 500.00 MAD) et apport en compte courant du dirigeant (5161 vers 4463, 10 000.00 MAD).
- **P-11, P-30, P-31** : Reclassifications TVA non déductible (carburant véhicule de tourisme, réception restaurant, paiement espèces au-delà du plafond 5 000 MAD proratisé via (5000 / TTC) * TVA).
- **P-12, P-13, P-14** : Écart de règlement mineur (<= 50 MAD) vers 6147 + TVA 10% ; pertes de change réalisées sur règlements étrangers vers 6331.
- **P-15 à P-23 (Cut-off)** : Facture de vente manquante (P-15), extourne FNP juillet précédent non reprise (P-16), régularisations FNP/FAE août (P-17 à P-19), report PCA (P-20), charge constatée d'avance SoftCloud CCA (11/12e = 33 000.00 MAD, preuve CALC:cca(...), comptes 3491/6131) (P-21), amortissement CCA assurance flotte (P-22), intérêts courus sur emprunt 77120 (> 1 000 MAD, exact/360, 4493, extourne 2026-09-01) (P-23).
- **P-24 à P-29 (Actifs & Provisions)** : Split capital/intérêt échéance d'emprunt depuis le tableau d'amortissement (P-24) ; ordinateur portable Dell capitalisé en 2355 + TVA en 34551 (P-25) ; MacBook reclassé en compte courant dirigeant 4463 avec TVA retirée et alerte légale bloquante levée (P-26) ; amortissement linéaire mensuel excluant les actifs totalement amortis (P-27) ; ajustement d'inventaire (P-28) ; provision pour perte de change latente sur solde en devise avec extourne au 2026-09-01 (P-29).
- **P-33 à P-36 (Social, Fiscal & Charges)** : Écriture complète de paie août depuis `journal_paie_2026-08.csv` avec compensation d'avance (P-33) ; majoration de retard CNSS (P-34) ; retenue à la source loyer 15% sur bailleur individuel (P-35) ; frais de voyage hôtel dirigeant saisi depuis `index_justificatifs` (61431 2 000.00 + 34552 200.00 / 4463 2 200.00) (P-36).
- **P-32 (Solde TVA)** : Génère l'écriture finale de règlement TVA :
  ```
  Débit 4455 (55 000.00) / Crédit 34552 (46 283.49) / Crédit 34551 (2 900.00) / Crédit 4456 (5 816.51)
  ```
  Confirme que `tva.json` correspond à : collectee = 55 000.00, deductible_charges = 46 283.49, deductible_immo = 2 900.00, tva_due = 5 816.51.

## Phase 6 — Généralisation & Durcissement
- Grep sur `src/` pour confirmer zéro chaîne spécifique à Atlas (pas de "Atlas", "ED-77812", "Transit Express", "BTP Chaouia", ni codes comptes hardcodés non résolus depuis plan_comptable.csv ou politique_cabinet.json).
- Assure que `dossier_cloture.md` et `trace.jsonl` sont complètement peuplés.
- Fais tourner la suite complète 3 fois consécutives pour garantir l'idempotence (variance 0).

## VÉRIFICATION FINALE
```
npm run typecheck
npm test
npm run cloture -- --dossier datasets/atlas_negoce --periode 2026-08 --sortie sortie_agent/
node evaluation/evaluer.mjs datasets/atlas_negoce/attendu sortie_agent/
```
Sors le tableau d'évaluation final sur les 8 axes, prouvant score >= 80 et 0 violation. Mets à jour `PROGRESS.md` en "MVP terminé". Commit et tag : `git tag mvp-final`.
