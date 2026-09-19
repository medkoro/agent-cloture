import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface TraceEvent {
  t: string;
  type: 'plan' | 'tool' | 'hypothese' | 'proposition' | 'verification' | 'decision' | 'error';
  [key: string]: unknown;
}

export class TraceWriter {
  constructor(private readonly path: string, private readonly clock: () => string = () => new Date().toISOString()) {}

  async write(event: Omit<TraceEvent, 't'>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify({ t: this.clock(), ...event })}\n`, 'utf8');
  }
}
