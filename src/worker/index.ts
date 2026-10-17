import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { config } from '../config.ts';
import { connection, createQueue, queueName } from '../shared/queue.ts';
import { createBus } from '../shared/bus.ts';
import type { Bus } from '../shared/bus.ts';
import { getAction, queueGroups } from '../actions/index.ts';
import { runCommand } from './runner.ts';
import type { JobData, JobResult } from '../types.ts';

const workerId = `${process.env.COMPUTERNAME || 'windows'}-${process.pid}`;
const log = (message: string) => console.log(`[worker ${workerId}] ${message}`);

async function processJob(job: Job<JobData, JobResult>, bus: Bus): Promise<JobResult> {
  const jobId = job.id ?? '';
  const action = getAction(job.data.action);
  if (!action) throw new Error(`Unknown action: ${job.data.action}`);
  const input = action.validate(job.data.input);
  const { file, args } = action.command(input);
  const run = runCommand({
    file,
    args,
    timeoutMs: action.timeoutMs,
    inputTimeoutMs: config.inputTimeoutMs,
    promptPatterns: action.promptPatterns,
    onEvent: (event) => {
      if (event.type === 'prompt') log(`${jobId} waiting for input: ${event.text}`);
      bus.publishEvent({ jobId, ...event }).catch((error: Error) => log(`publish failed: ${error.message}`));
    }
  });
  let cancelledBy: string | undefined;
  const unsubscribe = await bus.subscribeInput(jobId, (text) => run.sendInput(text), ({ by }) => {
    log(`${jobId} cancelled by ${by}`);
    cancelledBy = by;
    run.kill('Job đã bị huỷ.');
  });
  try {
    const result = await run.result;
    return { ...result, cancelledBy: result.cancelled ? cancelledBy : undefined, workerId, finishedAt: new Date().toISOString() };
  } finally {
    await unsubscribe().catch(() => {});
  }
}

async function main(): Promise<void> {
  const bus = createBus();
  const workers: Worker<JobData, JobResult>[] = [];
  for (const group of queueGroups) {
    // Global concurrency caps the queue across all worker processes; 1 means strictly sequential.
    const queue = createQueue(group.name);
    await queue.setGlobalConcurrency(group.concurrency);
    await queue.close();
    const worker = new Worker<JobData, JobResult>(queueName(group.name), (job) => processJob(job, bus), {
      connection,
      concurrency: group.concurrency,
      // A worker crash must not silently re-run a deploy: stalled jobs fail instead of being retried.
      maxStalledCount: 0
    });
    worker.on('ready', () => log(`ready on ${queueName(group.name)} (concurrency ${group.concurrency}: ${group.actions.join(', ')})`));
    worker.on('active', (job) => log(`started ${job.id} (${job.data.action})`));
    worker.on('completed', (job, result) => log(`finished ${job.id}: ${result.ok ? 'ok' : `failed (${result.reason || `exit ${result.exitCode}`})`}`));
    worker.on('failed', (job, error) => log(`failed ${job?.id}: ${error.message}`));
    worker.on('error', (error) => log(`error: ${error.message}`));
    workers.push(worker);
  }

  const shutdown = async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    bus.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
