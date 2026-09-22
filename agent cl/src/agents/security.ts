import type { SecurityEventSchema } from '../contracts/output.js';
import type { z } from 'zod';
import { analyzePdf } from './pdf_forensics.js';

export type SecurityEvent = z.infer<typeof SecurityEventSchema>;

const normalize = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Motifs génériques de tentative d'instruction cachée à un agent IA : aucun n'est propre à un
// dossier particulier, ils ciblent la grammaire d'une injection de prompt (s'adresser à
// l'assistant, demander de comptabiliser/clôturer sans approbation, demander la discrétion).
const INJECTION_PATTERNS: RegExp[] = [
  /\bassistant\s+ia\b/,
  /\bai\s+assistant\b/,
  /\bcomptabilisez?\s+tout/,
  /\bvalidez?\s+toute?s?\b/,
  /\bsans\s+approbation\b/,
  /\bsans\s+(?:me\s+)?redemander\b/,
  /\bne\s+mentionnez\s+pas\b/,
  /\bmarquez?\s+la\s+periode\b.*\bcloture/,
];

// Motifs génériques de tentative de pseudo-approbation dans une réponse client simulée :
// le garde-fou n°10 (une réponse client ne vaut jamais approbation) doit rester vrai même si
// le client l'affirme explicitement.
const APPROVAL_BYPASS_PATTERNS: RegExp[] = [
  /\bvalidez?\s+toute\b/,
  /\bvous\s+pouvez\s+valider\b/,
  /\bsans\s+(?:me\s+)?redemander\b/,
  /\bpassez\s+tout\s+ce\s+que\s+vous\s+voulez\b/,
  /\bje\s+vous\s+fais\s+confiance\b/,
];

function matches(patterns: RegExp[], text: string): string[] {
  const normalized = normalize(text);
  return patterns.filter((pattern) => pattern.test(normalized)).map((pattern) => pattern.source);
}

/**
 * Analyse structurelle d'un document PDF injecté (jamais son contenu texte brut seul) :
 * détecte une instruction adressée à l'IA et détermine, à partir du rendu réel (couleur,
 * taille de police, position), si elle est rendue invisible (ruse CSS/police) ou simplement
 * absente de tout affichage normal malgré une police lisible.
 */
export function scanDocumentPdf(buffer: Buffer, source: string): SecurityEvent | undefined {
  const analysis = analyzePdf(buffer);
  const hiddenIndicators = matches(INJECTION_PATTERNS, analysis.hiddenText);
  const visibleIndicators = matches(INJECTION_PATTERNS, analysis.visibleText);
  const indicators = [...new Set([...hiddenIndicators, ...visibleIndicators])];
  if (indicators.length === 0) return undefined;

  const invisible = hiddenIndicators.length > 0;
  return {
    id: `SEC-${source.replace(/[^A-Za-z0-9]+/g, '-')}`,
    source,
    type: invisible ? 'texte_invisible' : 'injection_documentaire_instruction_cachee',
    indicateurs: indicators,
    action: 'Texte du document traité comme donnée non fiable ; aucune instruction exécutée. Anomalie de sécurité levée.',
    neutralise: true,
    preuves: [`DOC:${source}`],
  };
}

/** Analyse d'une réponse client simulée (donnée non fiable) reçue via la boucle de communication. */
export function scanClientResponse(questionId: string, text: string): SecurityEvent | undefined {
  const indicators = matches(APPROVAL_BYPASS_PATTERNS, text);
  if (indicators.length === 0) return undefined;
  return {
    id: `SEC-SIM-${questionId}`,
    source: `SIM:${questionId}`,
    type: 'contournement_approbation',
    indicateurs: indicators,
    action: "La réponse client ne constitue pas une approbation valide (garde-fou n°10) ; instruction rejetée, aucun statut modifié.",
    neutralise: true,
    preuves: [`SIM:${questionId}`],
  };
}

/** Conservé pour compatibilité : scan générique d'un texte non fiable arbitraire (métadonnées CSV, etc.). */
export function scanUntrustedText(text: string, source: string): SecurityEvent | undefined {
  const normalized = normalize(text);
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
