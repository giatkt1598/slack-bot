const test = require('node:test');
const assert = require('node:assert/strict');
const { actions } = require('../src/actions');
const { enqueueJob, toJobId, jobLabel, formatCommand, isDirectMessage } = require('../src/bot/jobs');
const { createDatabase, getJob } = require('../src/shared/db');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('says "Đã thêm … vào hàng đợi" only when the job has to wait', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-bot-jobs-'));
  const db = await createDatabase(path.join(directory, 'jobs.sqlite'));
  const deploy = actions.find((action) => action.name === 'deploy'); // concurrency 1
  const status = actions.find((action) => action.name === 'status'); // concurrency 4
  const input = { ticket: 'GCD-111' };
  const posts = [];
  const client = { chat: { postMessage: async (message) => { posts.push(message.text); return { ts: '1.1' }; } } };
  const queueWith = (counts) => ({
    add: async () => {},
    getJobCounts: async () => ({ waiting: 0, prioritized: 0, delayed: 0, active: 0, ...counts })
  });
  const enqueue = (action, counts, jobId) => enqueueJob({ client, db, queue: queueWith(counts), action, input, channelId: 'D1', userId: 'U1', jobId });

  await enqueue(deploy, {}, 'job-1');
  await enqueue(deploy, { active: 1 }, 'job-2');
  await enqueue(status, { active: 1 }, 'job-3');
  await enqueue(status, { waiting: 1 }, 'job-4');

  assert.deepEqual(posts, [
    '#1 Đang chạy lệnh `gcmd deploy --ticket GCD-111`',
    'Đã thêm #2 `gcmd deploy --ticket GCD-111` vào hàng đợi',
    '#3 Đang chạy lệnh `gcmd status --ticket GCD-111`',
    'Đã thêm #4 `gcmd status --ticket GCD-111` vào hàng đợi'
  ]);
  assert.equal(getJob(db, 'job-1').announced, true);
  assert.equal(getJob(db, 'job-2').announced, false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('isDirectMessage recognises DM conversation ids', () => {
  assert.equal(isDirectMessage('D0123'), true);
  assert.equal(isDirectMessage('C0123'), false);
  assert.equal(isDirectMessage('G0123'), false);
});

test('enqueueJob posts top-level in DMs and threads in channels', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-bot-jobs-'));
  const db = await createDatabase(path.join(directory, 'jobs.sqlite'));
  const posts = [];
  const client = { chat: { postMessage: async (message) => { posts.push(message); return { ts: '200.1' }; } } };
  const queue = { add: async () => {}, getJobCounts: async () => ({ waiting: 0, prioritized: 0, delayed: 0, active: 0 }) };
  const deploy = actions.find((action) => action.name === 'deploy');
  const input = { ticket: 'GCD-1' };

  await enqueueJob({ client, db, queue, action: deploy, input, channelId: 'D1', userId: 'U1', replyThreadTs: '9.9', jobId: 'job-1' });
  await enqueueJob({ client, db, queue, action: deploy, input, channelId: 'C1', userId: 'U1', jobId: 'job-2' });
  await enqueueJob({ client, db, queue, action: deploy, input, channelId: 'C1', userId: 'U1', replyThreadTs: '5.5', jobId: 'job-3' });

  assert.equal(posts[0].thread_ts, undefined);
  assert.equal(posts[0].text, '#1 Đang chạy lệnh `gcmd deploy --ticket GCD-1`');
  assert.equal(getJob(db, 'job-1').threadTs, undefined);
  assert.equal(getJob(db, 'job-2').threadTs, '200.1');
  assert.equal(posts[2].thread_ts, '5.5');
  assert.equal(getJob(db, 'job-3').threadTs, '5.5');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('formatCommand shows the exact command line an action will run', () => {
  const deploy = actions.find((action) => action.name === 'deploy');
  assert.equal(formatCommand(deploy.command({ ticket: 'GCD-11' })), 'gcmd deploy --ticket GCD-11');
});

test('job ids are BullMQ-safe and render as #N', () => {
  assert.equal(toJobId(3), 'job-3');
  assert.equal(jobLabel('job-3'), '#3');
  // BullMQ rejects custom ids where `${parseInt(id, 10)}` === id, and ids containing ':'.
  const id = toJobId(42);
  assert.notEqual(`${parseInt(id, 10)}`, id);
  assert.ok(!id.includes(':'));
});
