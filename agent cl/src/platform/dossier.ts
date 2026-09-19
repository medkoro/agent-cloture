export interface DossierInput {
  state: string;
  period: string;
  propositionCount: number;
  blockingAnomalyCount: number;
  tvaDue: number;
  nextActions: string[];
}

export function renderClosingDossier(input: DossierInput): string {
  const amount = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(input.tvaDue).replace(/\u202f/g, ' ');
  const actions = input.nextActions.map((action) => `- ${action}`).join('\n');
  return `# Dossier de clôture\n\n- Période : ${input.period}\n- État : ${input.state}\n- Propositions : ${input.propositionCount}\n- Anomalies bloquantes : ${input.blockingAnomalyCount}\n- TVA due : ${amount} MAD\n\n## Prochaines actions\n${actions || '- Aucune'}\n`;
}
