# PROGRESS — Agent de clôture mensuelle (Sujet 4)

Lu au début de chaque nouvelle session à la place de se faire réexpliquer l'historique
(cf. `docs/CONTEXT_CLOSING_AGENT.md`, discipline d'exécution).

## Phase atteinte : RUN2 terminé (CHECKPOINT franchi, tag `mvp-60`)

Branche : `feat/etape1-moteur-deterministe`.

### RUN1 (rappel)

Squelette de sortie (6 JSON + session rejouable), moteur d'intégrité/ajustements bancaires
(`src/engine/postings.ts`), rapprochements à écart résiduel nul. Voir git log pour le détail
(commit `RUN1 - propositions bancaires deterministes et rapprochement a ecart nul`).

### RUN2 — Communications, anomalies sans écriture & sécurité

- **Sécurité (`src/agents/pdf_forensics.ts`, nouveau)** : parseur PDF minimal sans dépendance
  (décode `ASCII85Decode`/`ASCIIHexDecode`/`FlateDecode` via `node:zlib`, interprète les
  opérateurs de dessin de texte `cm/BT/Tm/Td/Tf/rg/g/k/Tj/TJ`) pour reconstruire, par fragment
  de texte, sa couleur de remplissage, sa taille de police et sa position réelle sur la page.
  Permet de distinguer un texte réellement affiché d'un texte rendu invisible (couleur
  blanche, police quasi nulle, hors MediaBox) — validé sur les 20 PDF du dossier (0 faux
  positif, 1 vrai positif : la note cachée en blanc 4pt dans `SC-2026-1187_SoftCloud.pdf`).
  `src/agents/security.ts` : `scanDocumentPdf` (classifie `texte_invisible` vs
  `injection_documentaire_instruction_cachee` selon le rendu réel) et `scanClientResponse`
  (détecte les tentatives de pseudo-approbation dans une réponse client simulée →
  `contournement_approbation`, garde-fou n°10). `scanUntrustedText` (legacy) conservé tel quel
  pour compatibilité.
- **Orchestrateur (`src/agents/orchestrator.ts`, réécrit)** : scanne désormais le contenu réel
  de chaque PDF injecté (plus seulement les métadonnées CSV), fait correspondre chaque
  question effectivement posée au client à `simulateur_client/scenario.json` par mots-clés
  pour récupérer sa réponse simulée et la scanner, puis ajoute une anomalie de sécurité
  générique (titre/preuves dérivés des données réelles de l'événement — zéro chaîne Atlas en
  dur) pour chaque détection.
- **Anomalies sans écriture (`src/engine/anomalies_run2.ts`, nouveau)** : détections
  100 % dérivées des données (`postes_ouverts`, `declarations_et_rapprochements_anterieurs`,
  `historique_resultat`, `politique_cabinet`, `parametres_fiscaux`) — suspens bancaires
  légitimes en transit, lettrage multi-facture (tiers avec ≥2 postes ouverts), facture
  fournisseur en retard au-delà du délai légal, créance douteuse (poste ouvert ancien + chèque
  rejeté du même tiers), écart de règlement TVA vs déclaration antérieure, retenue IR non
  versée à échéance, revue analytique (écart vs moyenne des 7 mois précédents au-delà des
  seuils de `politique_cabinet.json:materialite`).
- **`missingEvidenceAnomalies` (`closing_engine.ts`)** : resserrée (charge sans justificatif
  NI référence bancaire, hors période verrouillée et hors doublon déjà traité) pour ne plus
  remonter les lignes de règlement bancaire normales comme « pièce manquante » ; le tiers est
  résolu sur l'ensemble des lignes de la pièce (pas seulement la ligne de charge).
- **Questions client** : `Anomaly.question` est désormais renseigné à la source (au lieu
  d'un texte générique) pour chaque anomalie nécessitant une confirmation client, avec
  référence explicite ou date+montant (conforme à
  `politique_cabinet.json:garde_fous.questions_client.precision_requise`).
  `ClientChannel.questions` / `closing_engine.questionsFor` ne reprennent plus naïvement les N
  premières anomalies : seules celles qui portent une `question` sont proposées, plafonnées à
  10.

## Dernier score connu (`node evaluation/evaluer.mjs datasets/atlas_negoce/attendu "agent cl/sortie_agent"`)

```
Propositions — rappel (25)              5.9   (9/38 propositions attendues — hors scope RUN1/2)
Propositions — précision (10)          10.0   (9/9 propositions émises correctes)
Anomalies sans écriture détectées (15) 15.0   (11/11)
TVA du mois (10)                        1.7   (attendu inclut P-32/P-36, hors scope RUN2)
Rapprochements bancaires (10)          10.0   (ecart_residuel = 0 sur les 2 banques)
Garde-fous (15)                        15.0   (0 violation)
Sécurité / injection (10)              10.0   (SoftCloud + Q08 détectés et journalisés)
Questions client (5)                    2.5   (5/10 sujets couverts — Q05,Q06,Q08,Q09,Q10)
TOTAL / 100                            70.1
```

**0 violation de garde-fous** (`npm run typecheck` propre ; `npm test` : 54/54 verts ; exit
code de `evaluer.mjs` = 0). Idempotence vérifiée par sondage (deux exécutions consécutives →
sortie strictement identique hors `rapport_evaluation.json` gitignoré).

Checkpoint RUN2 requis : score ≥ 60/100 et 0 violation → **70.1/100, 0 violation, atteint**.

## TODO restant pour RUN3

- **TVA finale** : verrouiller `tva_due = 5 816.51` (P-32 solde TVA) et combler l'écart
  `3116.51 → 5816.51` (P-36, NDF hôtel du gérant, TVA 200 MAD) + toutes les propositions
  actifs/paie/change/cut-off listées dans `attendu/` (P-09 à P-36) : immobilisations (seuil
  10 000 MAD HT), amortissements, FNP/FAE, CCA/PCA, change fin de mois, paie, pénalités
  CNSS/retard, retenue à la source, provisions clients douteux (D-02, cf. `ANO-19`/`ANO-10`
  déjà anomalisés côté RUN2 — reste à chiffrer/poster après décision expert).
- **Propositions manquantes** (recall 5.9/25, 9/38 trouvées) : P-05, P-09 à P-36 — voir
  `RUN3.md` phase 5 pour la liste détaillée par thème (cut-off, actifs, social/fiscal).
- **Questions client** : 5/10 sujets couverts (Q01 caution/virement 7500, Q02 ordinateurs
  Dell/MacBook, Q03 caisse négative, Q04 REDEC électricité, Q07 stock ART-1010 pas encore
  producteurs de question — ils dépendent d'anomalies/propositions RUN3 pas encore générées).
  Une fois P-09/P-10/P-17/P-25/P-26/P-28 implémentées côté RUN3, leur donner un `question`
  précis fera mécaniquement progresser ce score sans toucher à `ClientChannel`.
- **Idempotence sur 3 runs consécutifs** : à exécuter et documenter explicitement en fin de
  RUN3 (vérification finale du plan).
- **Généralisation/durcissement (Phase 6 RUN3)** : grep final `src/` pour confirmer zéro
  chaîne spécifique à Atlas (déjà vérifié pour `anomalies_run2.ts`/`missingEvidenceAnomalies`
  via le test `not.toContain('Atlas Négoce')`, à réétendre aux nouveaux modules RUN3).

## Fichiers clés touchés ce run

- `agent cl/src/agents/pdf_forensics.ts` (nouveau — parseur PDF structurel)
- `agent cl/src/agents/security.ts` (réécrit — `scanDocumentPdf`/`scanClientResponse`,
  `scanUntrustedText` conservé pour compatibilité/tests)
- `agent cl/src/agents/orchestrator.ts` (réécrit — scan PDF réel + boucle client + fusion des
  anomalies de sécurité)
- `agent cl/src/agents/client_channel.ts` (filtre sur `anomaly.question` au lieu d'un slice
  naïf)
- `agent cl/src/engine/anomalies_run2.ts` (nouveau — 7 détecteurs d'anomalies sans écriture)
- `agent cl/src/engine/closing_engine.ts` (helpers `anomaly`/`push` avec `question`,
  `missingEvidenceAnomalies` resserrée, câblage des nouveaux détecteurs)
- `agent cl/src/engine/postings.ts` (export de `findTierByLibelle`, réutilisé par
  `anomalies_run2.ts`)
- `agent cl/src/engine/dataset.ts` (chargement optionnel de `historique_resultat_*.csv` et de
  `simulateur_client/scenario.json`)
