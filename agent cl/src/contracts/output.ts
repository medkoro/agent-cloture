import { z } from 'zod';

const amount = z.number().finite();

export const EntryLineSchema = z.object({
  compte: z.string().min(1),
  tiers: z.string().optional(),
  debit: amount.nonnegative(),
  credit: amount.nonnegative(),
}).strict();

export const PropositionSchema = z.object({
  id: z.string().min(1),
  anomalie: z.string().optional(),
  type: z.string().default('standard'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  journal: z.string().optional(),
  libelle: z.string().optional(),
  certitude: z.string().optional(),
  statut: z.string().default('proposee'),
  approuve_par: z.string().optional(),
  question_prealable: z.string().optional(),
  contre_passation_le: z.string().optional(),
  preuves: z.array(z.string().min(1)).min(1),
  lignes: z.array(EntryLineSchema).min(1),
}).strict();

export const AnomalySchema = z.object({
  id: z.string().min(1),
  chantier: z.string().optional(),
  famille: z.string().optional(),
  titre: z.string().min(1),
  description: z.string().optional(),
  gravite: z.string().optional(),
  action_attendue: z.string().optional(),
  preuves: z.array(z.string().min(1)).min(1),
  question: z.string().optional().nullable(),
}).strict();

export const TvaSchema = z.object({
  regime: z.string(),
  tva_collectee_exigible: amount,
  tva_deductible_charges: amount,
  tva_deductible_immobilisations: amount,
  credit_anterieur: amount,
  tva_due: amount,
  echeance: z.string().optional(),
  detail_collectee: z.array(z.record(z.unknown())).optional(),
  detail_deductible: z.array(z.record(z.unknown())).optional(),
}).strict();

export const BankReconciliationSchema = z.object({
  solde_releve: amount.optional(),
  solde_gl_avant: amount.optional(),
  solde_gl_apres: amount,
  ecart_residuel: amount,
  corrections: z.array(z.string()).optional(),
  suspens: z.array(z.record(z.unknown())).optional(),
  controle_totaux_imprimes: z.record(z.unknown()).optional(),
}).strict();

export const ReconciliationsSchema = z.record(BankReconciliationSchema);

export const QuestionSchema = z.object({
  id: z.string().optional(),
  texte: z.string().min(1),
  sujet: z.string().optional(),
  preuve: z.string().optional(),
}).strict();

export const SecurityEventSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  type: z.string().min(1),
  indicateurs: z.array(z.string().min(1)).min(1),
  action: z.string().min(1),
  neutralise: z.boolean(),
  preuves: z.array(z.string().min(1)).min(1),
}).strict();

export const OutputSchema = z.object({
  propositions: z.array(PropositionSchema),
  anomalies: z.array(AnomalySchema),
  tva: TvaSchema,
  rapprochements: ReconciliationsSchema,
  questions: z.array(QuestionSchema).max(10),
  journal_securite: z.array(SecurityEventSchema),
}).strict();

export type Output = z.infer<typeof OutputSchema>;
export type Proposition = z.infer<typeof PropositionSchema>;
export type Anomaly = z.infer<typeof AnomalySchema>;
export type EntryLine = z.infer<typeof EntryLineSchema>;
