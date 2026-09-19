import type { Pool } from 'mysql2/promise';
import type { ClosingSession, ClosingSessionStore } from './closing_service.js';

export class MysqlClosingSessionStore implements ClosingSessionStore {
  constructor(private readonly pool: Pool) {}

  async save(session: ClosingSession): Promise<void> {
    await this.pool.execute(
      `INSERT INTO closing_sessions (id, dossier, period, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = VALUES(updated_at)`,
      [session.id, session.dossier, session.period, session.state, session.createdAt, session.updatedAt],
    );
  }

  async get(id: string): Promise<ClosingSession | undefined> {
    const [rows] = await this.pool.execute('SELECT id, dossier, period, state, created_at AS createdAt, updated_at AS updatedAt FROM closing_sessions WHERE id = ?', [id]);
    const row = (rows as ClosingSession[])[0];
    return row;
  }
}
