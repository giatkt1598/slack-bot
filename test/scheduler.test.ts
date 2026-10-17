import test from 'node:test';
import assert from 'node:assert/strict';
import { defineCommands } from '../src/commands/index.ts';
import { createScheduler } from '../src/worker/scheduler.ts';
import type { CommandDefinition, JobResult, RunnerEvent } from '../src/types.ts';

// Fast commands (node -e) instead of the gcmd mock, so these tests don't depend on its delays.
const nodeScript = (name: string, script: string, queue: CommandDefinition['queue'], extra: Partial<CommandDefinition> = {}): CommandDefinition => ({
  name,
  description: name,
  usage: name,
  queue,
  parse: (args) => ({ value: args }),
  validate: (input) => {
    if (input.value === 'invalid') throw new Error('Invalid value.');
    return input;
  },
  build: () => ({ file: process.execPath, args: ['-e', script] }),
  ...extra
});

const registry = defineCommands([
  nodeScript('serial', 'setTimeout(() => console.log("done"), 150)', { name: 'serial', concurrency: 1 }),
  nodeScript('parallel', 'setTimeout(() => console.log("done"), 150)', { name: 'parallel', concurrency: 3 }),
  nodeScript('forever', 'setInterval(() => console.log("tick"), 50)', { name: 'forever', concurrency: 1 }),
  nodeScript('ask', 'process.stdout.write("Continue? [y/n] "); process.stdin.once("data", (d) => { console.log("got " + d.toString().trim()); process.exit(0); })',
    { name: 'ask', concurrency: 1 }, { promptPatterns: [/\[y\/n\]\s*$/i] })
]);

// `failReport` makes onFinish reject for those job ids (e.g. Slack being down while reporting).
function setup({ failReport = [] as string[] } = {}) {
  const timeline: string[] = [];
  const events = new Map<string, RunnerEvent[]>();
  const results = new Map<string, JobResult>();
  const waiters = new Map<string, (result: JobResult) => void>();
  const reportWaiters = new Map<string, () => void>();
  const scheduler = createScheduler({
    groups: registry.queueGroups,
    inputTimeoutMs: 5000,
    onStart: async (job) => {
      timeline.push(`start ${job.id}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      timeline.push(`started ${job.id}`);
    },
    onEvent: (jobId, event) => {
      if (!events.has(jobId)) events.set(jobId, []);
      events.get(jobId)!.push(event);
      if (event.type === 'output' && !timeline.includes(`output ${jobId}`)) timeline.push(`output ${jobId}`);
    },
    // Reporting takes a while (Slack calls), like the real onFinish.
    onFinish: async (jobId, result) => {
      timeline.push(`finish ${jobId}`);
      results.set(jobId, result);
      waiters.get(jobId)?.(result);
      await new Promise((resolve) => setTimeout(resolve, 30));
      timeline.push(`finish-reported ${jobId}`);
      reportWaiters.get(jobId)?.();
      if (failReport.includes(jobId)) throw new Error(`report failed for ${jobId}`);
    }
  });
  const enqueue = (id: string, commandName: string, value = '') =>
    scheduler.enqueue({ id, command: registry.getCommand(commandName)!, input: { value } });
  // Resolves when the scheduler hands the result to onFinish.
  const finished = (id: string) => results.has(id)
    ? Promise.resolve(results.get(id)!)
    : new Promise<JobResult>((resolve) => waiters.set(id, resolve));
  // Resolves once onFinish has completed (the slot is freed right after).
  const reported = (id: string) => timeline.includes(`finish-reported ${id}`)
    ? Promise.resolve()
    : new Promise<void>((resolve) => reportWaiters.set(id, () => setImmediate(resolve)));
  return { scheduler, timeline, events, enqueue, finished, reported };
}

test('a concurrency-1 queue runs jobs strictly one after another', async () => {
  const { timeline, enqueue, finished } = setup();
  enqueue('a', 'serial');
  enqueue('b', 'serial');
  await finished('b');
  assert.ok(timeline.indexOf('finish a') < timeline.indexOf('start b'), timeline.join(' | '));
});

test('the next job starts only after the previous job has been fully reported', async () => {
  const { timeline, enqueue, finished } = setup();
  enqueue('a', 'serial');
  enqueue('b', 'serial');
  await finished('b');
  assert.ok(timeline.indexOf('finish-reported a') < timeline.indexOf('start b'), timeline.join(' | '));
});

test('a failing report does not block the queue', async () => {
  const { enqueue, finished } = setup({ failReport: ['a'] });
  enqueue('a', 'serial');
  enqueue('b', 'serial');
  assert.equal((await finished('b')).ok, true);
});

test('a concurrency-N queue runs jobs in parallel', async () => {
  const { timeline, enqueue, finished } = setup();
  enqueue('a', 'parallel');
  enqueue('b', 'parallel');
  enqueue('c', 'parallel');
  await Promise.all(['a', 'b', 'c'].map(finished));
  assert.ok(timeline.indexOf('start c') < timeline.indexOf('finish a'), timeline.join(' | '));
});

test('mustWait reflects waiting jobs and busy slots per queue', async () => {
  const { scheduler, enqueue, finished, reported } = setup();
  assert.equal(scheduler.mustWait('serial'), false);
  enqueue('a', 'serial');
  assert.equal(scheduler.mustWait('serial'), true);
  assert.equal(scheduler.mustWait('parallel'), false);
  await finished('a');
  // Still busy while the completion is being reported.
  assert.equal(scheduler.mustWait('serial'), true);
  await reported('a');
  assert.equal(scheduler.mustWait('serial'), false);
});

test('snapshot lists running and waiting jobs per queue in order', async () => {
  const { scheduler, enqueue, reported } = setup();
  enqueue('a', 'serial');
  enqueue('b', 'serial');
  enqueue('c', 'serial');
  const serial = scheduler.snapshot().find((queue) => queue.name === 'serial')!;
  assert.deepEqual(serial.active.map((job) => job.id), ['a']);
  assert.deepEqual(serial.waiting.map((job) => job.id), ['b', 'c']);
  assert.equal(serial.concurrency, 1);
  await reported('c');
  const after = scheduler.snapshot().find((queue) => queue.name === 'serial')!;
  assert.deepEqual([after.active.length, after.waiting.length], [0, 0]);
});

test('onStart completes before the command produces output', async () => {
  const { timeline, enqueue, finished } = setup();
  enqueue('a', 'serial');
  await finished('a');
  assert.ok(timeline.indexOf('started a') < timeline.indexOf('output a'), timeline.join(' | '));
});

test('removeQueued drops a job that has not started', async () => {
  const { scheduler, timeline, enqueue, finished } = setup();
  enqueue('a', 'serial');
  enqueue('b', 'serial');
  assert.equal(scheduler.removeQueued('b'), true);
  assert.equal(scheduler.removeQueued('a'), false);
  await finished('a');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!timeline.includes('start b'));
});

test('cancel kills a running job and records who cancelled it', async () => {
  const { scheduler, enqueue, finished, events } = setup();
  enqueue('a', 'forever');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(events.get('a')?.some((event) => event.type === 'output'));
  assert.equal(scheduler.cancel('a', 'U1'), true);
  const result = await finished('a');
  assert.equal(result.cancelled, true);
  assert.equal(result.cancelledBy, 'U1');
  assert.equal(scheduler.cancel('a', 'U1'), false);
});

test('cancel during onStart still kills the job once it spawns', async () => {
  const { scheduler, enqueue, finished } = setup();
  enqueue('a', 'forever');
  assert.equal(scheduler.cancel('a', 'U2'), true);
  const result = await finished('a');
  assert.equal(result.cancelled, true);
  assert.equal(result.cancelledBy, 'U2');
});

test('sendInput answers a running prompt', async () => {
  const { scheduler, enqueue, finished, events } = setup();
  enqueue('a', 'ask');
  while (!events.get('a')?.some((event) => event.type === 'prompt')) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(scheduler.sendInput('a', 'yes'), true);
  const result = await finished('a');
  assert.equal(result.ok, true);
  assert.match(result.stdoutTail, /got yes/);
  assert.equal(scheduler.sendInput('a', 'late'), false);
});

test('a validation error at start becomes a failed result and frees the slot', async () => {
  const { enqueue, finished } = setup();
  enqueue('a', 'serial', 'invalid');
  enqueue('b', 'serial');
  const failed = await finished('a');
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'Invalid value.');
  assert.equal((await finished('b')).ok, true);
});
