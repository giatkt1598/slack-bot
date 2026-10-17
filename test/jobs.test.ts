import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueJob, toJobId, jobLabel, formatCommand, isDirectMessage } from '../src/bot/jobs.ts';
import type { EnqueueOptions } from '../src/bot/jobs.ts';
import type { SlackMessage } from '../src/bot/slack.ts';
import { getJob } from '../src/shared/db.ts';
import { bundledAction, tempDatabase } from './helpers.ts';

type Counts = Partial<Record<'waiting' | 'prioritized' | 'delayed' | 'active', number>>;

function fakeQueue(counts: Counts = {}): EnqueueOptions['queue'] {
  return {
    add: async () => undefined,
    getJobCounts: async () => ({ waiting: 0, prioritized: 0, delayed: 0, active: 0, ...counts })
  } as unknown as EnqueueOptions['queue'];
}

function fakeClient(ts: string) {
  const posts: SlackMessage[] = [];
  const client = { chat: { postMessage: async (message: SlackMessage) => { posts.push(message); return { ts }; }, update: async () => ({}) } };
  return { client, posts };
}

test('says "Đã thêm … vào hàng đợi" only when the job has to wait', async (t) => {
  const { db } = await tempDatabase(t);
  const deploy = bundledAction('deploy'); // concurrency 1
  const status = bundledAction('status'); // concurrency 4
  const { client, posts } = fakeClient('1.1');
  const enqueue = (action: typeof deploy, counts: Counts, jobId: string) =>
    enqueueJob({ client, db, queue: fakeQueue(counts), action, input: { ticket: 'GCD-111' }, channelId: 'D1', userId: 'U1', jobId });

  await enqueue(deploy, {}, 'job-1');
  await enqueue(deploy, { active: 1 }, 'job-2');
  await enqueue(status, { active: 1 }, 'job-3');
  await enqueue(status, { waiting: 1 }, 'job-4');

  assert.deepEqual(posts.map((post) => post.text), [
    '#1 Đang chạy lệnh `gcmd deploy --ticket GCD-111`',
    'Đã thêm #2 `gcmd deploy --ticket GCD-111` vào hàng đợi',
    '#3 Đang chạy lệnh `gcmd status --ticket GCD-111`',
    'Đã thêm #4 `gcmd status --ticket GCD-111` vào hàng đợi'
  ]);
  assert.equal(getJob(db, 'job-1')?.announced, true);
  assert.equal(getJob(db, 'job-2')?.announced, false);
});

test('isDirectMessage recognises DM conversation ids', () => {
  assert.equal(isDirectMessage('D0123'), true);
  assert.equal(isDirectMessage('C0123'), false);
  assert.equal(isDirectMessage('G0123'), false);
});

test('enqueueJob posts top-level in DMs and threads in channels', async (t) => {
  const { db } = await tempDatabase(t);
  const { client, posts } = fakeClient('200.1');
  const options = { client, db, queue: fakeQueue(), action: bundledAction('deploy'), input: { ticket: 'GCD-1' }, userId: 'U1' };

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
