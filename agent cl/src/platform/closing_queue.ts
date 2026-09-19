import { Queue, Worker } from 'bullmq';
import type { ClosingService } from './closing_service.js';

export interface ClosingJob {
  dossier: string;
  period: string;
  datasetDir: string;
}

export function createClosingQueue(connection: { host: string; port: number }): Queue<ClosingJob> {
  return new Queue<ClosingJob>('closing-sessions', { connection });
}

export function createClosingWorker(connection: { host: string; port: number }, service: ClosingService): Worker<ClosingJob> {
  return new Worker<ClosingJob>('closing-sessions', async (job) => service.run(job.data), { connection });
}
