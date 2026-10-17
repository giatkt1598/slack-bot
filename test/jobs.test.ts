import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueJob, toJobId, jobLabel, formatCommand, isDirectMessage } from '../src/bot/jobs.ts';
import type { EnqueueOptions } from '../src/bot/jobs.ts';
import type { SlackMessage } from '../src/bot/slack.ts';
import { getJob } from '../src/shared/db.ts';
import { bundledAction, tempDatabase } from './helpers.ts';

// A scheduler stand-in: `waits` is what mustWait answers; enqueued job ids are recorded.
function fakeScheduler(waits = false) {
  const enqueued: string[] = [];
  const scheduler: EnqueueOptions['scheduler'] = { mustWait: () => waits, enqueue: (job) => void enqueued.push(job.id) };
  return { scheduler, enqueued };
}

function fakeClient(ts: string) {
  const posts: SlackMessage[] = [];
  const client = { chat: { postMessage: async (message: SlackMessage) => { posts.push(message); return { ts }; }, update: async () => ({}) } };
  return { client, posts };
}

test('says "Đã thêm … vào hàng đợi" only when the job has to wait', async (t) => {
  const { db } = await tempDatabase(t);
  const deploy = bundledAction('deploy');
  const status = bundledAction('status');
  const { client, posts } = fakeClient('1.1');
  const enqueued: string[] = [];
  const enqueue = (action: typeof deploy, waits: boolean, jobId: string) => {
    const fake = fakeScheduler(waits);
    return enqueueJob({ client, db, scheduler: fake.scheduler, action, input: { ticket: 'GCD-111' }, channelId: 'D1', userId: 'U1', jobId })
      .then(() => enqueued.push(...fake.enqueued));
  };

  await enqueue(deploy, false, 'job-1');
  await enqueue(deploy, true, 'job-2');
  await enqueue(status, false, 'job-3');
  await enqueue(status, true, 'job-4');

  assert.deepEqual(posts.map((post) => post.text), [
    '#1 Đang chạy lệnh `gcmd deploy --ticket GCD-111`',
    'Đã thêm #2 `gcmd deploy --ticket GCD-111` vào hàng đợi',
    '#3 Đang chạy lệnh `gcmd status --ticket GCD-111`',
    'Đã thêm #4 `gcmd status --ticket GCD-111` vào hàng đợi'
  ]);
  assert.equal(getJob(db, 'job-1')?.announced, true);
  assert.equal(getJob(db, 'job-2')?.announced, false);
  assert.deepEqual(enqueued, ['job-1', 'job-2', 'job-3', 'job-4']);
});

test('isDirectMessage recognises DM conversation ids', () => {
  assert.equal(isDirectMessage('D0123'), true);
  assert.equal(isDirectMessage('C0123'), false);
  assert.equal(isDirectMessage('G0123'), false);
});

test('enqueueJob posts top-level in DMs and threads in channels', async (t) => {
  const { db } = await tempDatabase(t);
  const { client, posts } = fakeClient('200.1');
  const options = { client, db, scheduler: fakeScheduler().scheduler, action: bundledAction('deploy'), input: { ticket: 'GCD-1' }, userId: 'U1' };

  await enqueueJob({ ...options, channelId: 'D1', replyThreadTs: '9.9', jobId: 'job-1' });
  await enqueueJob({ ...options, channelId: 'C1', jobId: 'job-2' });
  await enqueueJob({ ...options, channelId: 'C1', replyThreadTs: '5.5', jobId: 'job-3' });

  assert.equal(posts[0].thread_ts, undefined);
  assert.equal(posts[0].text, '#1 Đang chạy lệnh `gcmd deploy --ticket GCD-1`');
  assert.equal(getJob(db, 'job-1')?.threadTs, undefined);
  assert.equal(getJob(db, 'job-2')?.threadTs, '200.1');
  assert.equal(posts[2].thread_ts, '5.5');
  assert.equal(getJob(db, 'job-3')?.threadTs, '5.5');
});

test('formatCommand shows the exact command line an action will run', () => {
  assert.equal(formatCommand(bundledAction('deploy').command({ ticket: 'GCD-11' })), 'gcmd deploy --ticket GCD-11');
});

test('job ids are BullMQ-safe and render as #N', () => {
  assert.equal(toJobId(3), 'job-3');
  assert.equal(jobLabel('job-3'), '#3');
  // BullMQ rejects custom ids where `${parseInt(id, 10)}` === id, and ids containing ':'.
  const id = toJobId(42);
  assert.notEqual(`${parseInt(id, 10)}`, id);
  assert.ok(!id.includes(':'));
});
