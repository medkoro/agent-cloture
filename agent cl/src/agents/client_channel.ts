import type { Anomaly, Output } from '../contracts/output.js';

export class ClientChannel {
  questions(anomalies: Anomaly[], maximum = 10): Output['questions'] {
    return anomalies.slice(0, Math.max(0, maximum)).map((anomaly) => ({
      id: anomaly.id,
      sujet: anomaly.titre,
      texte: anomaly.question ?? `Merci de fournir la preuve ou la décision nécessaire pour traiter : ${anomaly.titre}.`,
      preuve: anomaly.preuves[0],
    }));
  }
}
