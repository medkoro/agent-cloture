import { useEffect, useState } from 'react';

type Session = { id: string; dossier: string; period: string; state: string; updatedAt: string };

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<Session | undefined>();
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/clotures').then(async (response) => {
      if (!response.ok) throw new Error('API indisponible');
      return response.json() as Promise<Session[]>;
    }).then(setSessions).catch((reason: Error) => setError(reason.message));
  }, []);

  return <main className="shell">
    <header><p className="eyebrow">Fiduciaire · cockpit de clôture</p><h1>Revue mensuelle</h1><p className="intro">Les propositions restent en attente jusqu’à l’approbation de l’expert-comptable.</p></header>
    {error && <p className="error">{error}</p>}
    <section className="grid">
      <div className="panel"><div className="panel-title"><h2>Sessions</h2><span>{sessions.length} dossier(s)</span></div>
        {sessions.length === 0 ? <p className="muted">Aucune session. Lancez une clôture via l’API.</p> : sessions.map((session) => <button className={`session ${selected?.id === session.id ? 'active' : ''}`} onClick={() => setSelected(session)} key={session.id}><strong>{session.dossier}</strong><span>{session.period}</span><em>{session.state}</em></button>)}
      </div>
      <div className="panel review"><div className="panel-title"><h2>Revue</h2>{selected && <span>{selected.id.slice(0, 8)}</span>}</div>{selected ? <><div className="status"><span>État</span><strong>{selected.state}</strong></div><div className="status"><span>Période</span><strong>{selected.period}</strong></div><p className="muted">Les preuves, anomalies et propositions sont disponibles dans le dossier de session.</p><button className="primary">Ouvrir la revue des propositions</button></> : <p className="muted">Sélectionnez une session pour commencer.</p>}</div>
    </section>
  </main>;
}
