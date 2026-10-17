import test from 'node:test';
import assert from 'node:assert/strict';
import { defineActions } from '../src/actions/index.ts';
import { createScheduler } from '../src/worker/scheduler.ts';
import type { ActionDefinition, JobResult, RunnerEvent } from '../src/types.ts';

// Fast commands (node -e) instead of the gcmd mock, so these tests don't depend on its delays.
const nodeScript = (name: string, script: string, queue: ActionDefinition['queue'], extra: Partial<ActionDefinition> = {}): ActionDefinition => ({
  name,
  description: name,
  usage: name,
  queue,
  parse: (args) => ({ value: args }),
  validate: (input) => {
    if (input.value === 'invalid') throw new Error('Giá trị không hợp lệ.');
    return input;
  },
  command: () => ({ file: process.execPath, args: ['-e', script] }),
  ...extra
});

const registry = defineActions([
  nodeScript('serial', 'setTimeout(() => console.log("done"), 150)', { name: 'serial', concurrency: 1 }),
  nodeScript('parallel', 'setTimeout(() => console.log("done"), 150)', { name: 'parallel', concurrency: 3 }),
  nodeScript('forever', 'setInterval(() => console.log("tick"), 50)', { name: 'forever', concurrency: 1 }),
  nodeScript('ask', 'process.stdout.write("Continue? [y/n] "); process.stdin.once("data", (d) => { console.log("got " + d.toString().trim()); process.exit(0); })',
    { name: 'ask', concurrency: 1 }, { promptPatterns: [/\[y\/n\]\s*$/i] })
]);

function setup() {
  const timeline: string[] = [];
  const events = new Map<string, RunnerEvent[]>();
  const results = new Map<string, JobResult>();
  const waiters = new Map<string, (result: JobResult) => void>();
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
    onFinish: (jobId, result) => {
      timeline.push(`finish ${jobId}`);
      results.set(jobId, result);
      waiters.get(jobId)?.(result);
    }
  });
  const enqueue = (id: string, actionName: string, value = '') =>
    scheduler.enqueue({ id, action: registry.getAction(actionName)!, input: { value } });
  const finished = (id: string) => results.has(id)
    ? Promise.resolve(results.get(id)!)
    : new Promise<JobResult>((resolve) => waiters.set(id, resolve));
  return { scheduler, timeline, events, enqueue, finished };
}

test('a concurrency-1 queue runs jobs strictly one after another', async () => {
  const { timeline, enqueue, finished } = setup();
  enqueue('a', 'serial');
  enqueue('b', 'serial');
  await finished('b');
  assert.ok(timeline.indexOf('finish a') < timeline.indexOf('start b'), timeline.join(' | '));
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
  const { scheduler, enqueue, finished } = setup();
  assert.equal(scheduler.mustWait('serial'), false);
  enqueue('a', 'serial');
  assert.equal(scheduler.mustWait('serial'), true);
  assert.equal(scheduler.mustWait('parallel'), false);
  await finished('a');
  assert.equal(scheduler.mustWait('serial'), false);
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
  assert.equal(failed.reason, 'Giá trị không hợp lệ.');
  assert.equal((await finished('b')).ok, true);
});
