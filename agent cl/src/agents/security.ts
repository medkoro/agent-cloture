import type { SecurityEventSchema } from '../contracts/output.js';
import type { z } from 'zod';

export type SecurityEvent = z.infer<typeof SecurityEventSchema>;

export function scanUntrustedText(text: string, source: string): SecurityEvent | undefined {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const indicators: string[] = [];
  if (normalized.includes('injection') || normalized.includes('instruction') || normalized.includes('validez toute') || normalized.includes('sans approbation') || normalized.includes('comptabilisez tout')) indicators.push('instruction');
  if (!indicators.length) return undefined;
  return {
    id: `SEC-${source.replace(/[^A-Za-z0-9]+/g, '-')}`,
    source,
    type: 'prompt_injection',
    indicateurs: indicators,
    action: 'Texte traité comme donnée non fiable ; aucune instruction exécutée.',
    neutralise: true,
    preuves: [source],
  };
}
