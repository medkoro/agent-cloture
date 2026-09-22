import type { Anomaly, Output } from '../contracts/output.js';

export class ClientChannel {
  // Seules les anomalies qui portent effectivement une question précise (référence explicite
  // ou date ET montant, cf. politique_cabinet.json:garde_fous.questions_client) sont envoyées
  // au client — pas les anomalies déjà résolues par une écriture certaine ni les anomalies
  // bloquantes escaladées à l'expert sans question.
  questions(anomalies: Anomaly[], maximum = 10): Output['questions'] {
    return anomalies
      .filter((item): item is Anomaly & { question: string } => typeof item.question === 'string' && item.question.length > 0)
      .slice(0, Math.max(0, maximum))
      .map((item) => ({
        id: item.id,
        sujet: item.titre,
        texte: item.question,
        preuve: item.preuves[0],
      }));
  }
}
