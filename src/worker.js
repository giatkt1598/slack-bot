const { Worker } = require('bullmq');
const { config } = require('./config');
const { connection } = require('./queue');
const { actions } = require('./actions');

const workerId = `${process.env.COMPUTERNAME || 'windows'}-${process.pid}`;

async function main() {
  const worker = new Worker(config.queueName, async (job) => {
    const action = actions[job.data.action];
    if (!action) throw new Error(`Unknown action: ${job.data.action}`);
    const input = action.validate(job.data.input);
    const result = await action.execute({ ...input, timeoutMs: config.commandTimeoutMs });
    return {
      ...result,
      workerId,
      finishedAt: new Date().toISOString()
    };
  }, {
    connection,
    concurrency: config.workerConcurrency,
    autorun: true
  });

  worker.on('ready', () => console.log(`[worker ${workerId}] ready`));
  worker.on('active', (job) => console.log(`[worker ${workerId}] started ${job.id}`));
  worker.on('failed', (job, error) => console.error(`[worker ${workerId}] failed ${job?.id}: ${error.message}`));
  process.on('SIGINT', () => worker.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => worker.close().then(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
