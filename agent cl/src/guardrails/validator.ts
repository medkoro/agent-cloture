import { OutputSchema, type Output } from '../contracts/output.js';
import { GuardrailError } from './errors.js';

const POSTED = new Set(['postee', 'comptabilisee', 'posted']);

const cents = (value: number): number => Math.round(value * 100);

export interface ValidationRules {
  lockedThrough?: string;
  collectiveAccounts?: string[];
}

export function validateOutput(input: unknown, rules: ValidationRules = {}): Output {
  const parsed = OutputSchema.safeParse(input);
  if (!parsed.success) {
    throw new GuardrailError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }

  const violations: string[] = [];
  for (const proposition of parsed.data.propositions) {
    const debit = proposition.lignes.reduce((sum, line) => sum + cents(line.debit), 0);
    const credit = proposition.lignes.reduce((sum, line) => sum + cents(line.credit), 0);
    if (debit !== credit && proposition.type !== 'complement') {
      violations.push(`${proposition.id}: écriture déséquilibrée (${debit / 100} != ${credit / 100})`);
    }
    if (rules.lockedThrough && proposition.date <= rules.lockedThrough) {
      violations.push(`${proposition.id}: date ${proposition.date} dans une période verrouillée`);
    }
    for (const line of proposition.lignes) {
      if (rules.collectiveAccounts?.includes(line.compte)) {
        violations.push(`${proposition.id}: compte collectif ${line.compte} mouvementé`);
      }
    }
    if (POSTED.has(proposition.statut.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()) && !proposition.approuve_par) {
      violations.push(`${proposition.id}: postée sans approbation humaine`);
    }
    if (proposition.preuves.length === 0) {
      violations.push(`${proposition.id}: aucune preuve citée`);
    }
  }
  for (const anomaly of parsed.data.anomalies) {
    if (anomaly.preuves.length === 0) violations.push(`${anomaly.id}: aucune preuve citée`);
  }
  if (parsed.data.questions.length > 10) violations.push('plus de 10 questions client');
  if (violations.length) throw new GuardrailError(violations);
  return parsed.data;
}
