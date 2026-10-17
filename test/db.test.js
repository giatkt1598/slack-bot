const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase, insertJob, updateJob, getJob, findActiveJobByThread, findWaitingJobInChannel, maxJobNumber } = require('../src/shared/db');

test('DM jobs have no thread and the newest waiting one is found per conversation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-bot-db-'));
  const db = await createDatabase(path.join(directory, 'jobs.sqlite'));
  const base = { action: 'deploy', inputJson: '{}', channelId: 'D1', threadTs: '', userId: 'U1' };
  insertJob(db, { ...base, id: 'job-1', createdAt: '2026-01-01T00:00:00Z' });
  insertJob(db, { ...base, id: 'job-2', createdAt: '2026-01-02T00:00:00Z' });
  insertJob(db, { ...base, id: 'job-3', channelId: 'D2', createdAt: '2026-01-03T00:00:00Z' });
  assert.equal(getJob(db, 'job-1').threadTs, undefined);
  assert.equal(findWaitingJobInChannel(db, 'D1'), null);

  for (const id of ['job-1', 'job-2', 'job-3']) updateJob(db, id, { status: 'waiting_input' });
  assert.equal(findWaitingJobInChannel(db, 'D1').id, 'job-2');
  updateJob(db, 'job-2', { status: 'running' });
  assert.equal(findWaitingJobInChannel(db, 'D1').id, 'job-1');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('stores whether the running message was posted, and migrates older databases', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-bot-db-'));
  const filename = path.join(directory, 'jobs.sqlite');
  // A database created before the "announced" column existed.
  const SQL = await require('sql.js')();
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE jobs (id TEXT PRIMARY KEY, action TEXT NOT NULL, input_json TEXT NOT NULL, status TEXT NOT NULL,
    slack_channel_id TEXT NOT NULL, slack_thread_ts TEXT NOT NULL, slack_user_id TEXT NOT NULL, created_at TEXT NOT NULL,
    started_at TEXT, finished_at TEXT, exit_code INTEGER, output_summary TEXT, error_summary TEXT)`);
  legacy.run("INSERT INTO jobs VALUES ('job-1', 'deploy', '{}', 'succeeded', 'C1', '1.1', 'U1', '2026-01-01', null, null, 0, null, null)");
  fs.writeFileSync(filename, Buffer.from(legacy.export()));

  const db = await createDatabase(filename);
  assert.equal(getJob(db, 'job-1').announced, true);
  const base = { action: 'deploy', inputJson: '{}', channelId: 'C1', threadTs: '1.1', userId: 'U1', createdAt: '2026-01-02' };
  insertJob(db, { ...base, id: 'job-2', announced: false });
  assert.equal(getJob(db, 'job-2').announced, false);
  updateJob(db, 'job-2', { announced: 1 });
  assert.equal(getJob(db, 'job-2').announced, true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('maxJobNumber returns the highest job-N id and ignores legacy UUIDs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-bot-db-'));
  const db = await createDatabase(path.join(directory, 'jobs.sqlite'));
  assert.equal(maxJobNumber(db), 0);
  const base = { action: 'deploy', inputJson: '{}', channelId: 'C1', threadTs: '1.1', userId: 'U1', createdAt: '2026-01-01T00:00:00Z' };
  for (const id of ['job-2', 'job-10', 'job-9', '1b4e28ba-2fa1-11d2-883f-0016d3cca427']) insertJob(db, { ...base, id });
  assert.equal(maxJobNumber(db), 10);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('finds the active job for a thread and reads it back', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-bot-db-'));
  const db = await createDatabase(path.join(directory, 'jobs.sqlite'));
  const base = { action: 'deploy', inputJson: '{"ticket":"GCD-1"}', channelId: 'C1', threadTs: '1.1', userId: 'U1' };
  insertJob(db, { ...base, id: 'old', createdAt: '2026-01-01T00:00:00Z' });
  insertJob(db, { ...base, id: 'new', createdAt: '2026-01-02T00:00:00Z' });
  updateJob(db, 'old', { status: 'succeeded', exitCode: undefined });

  assert.equal(findActiveJobByThread(db, 'C1', '1.1').id, 'new');
  assert.equal(findActiveJobByThread(db, 'C1', '9.9'), null);
  updateJob(db, 'new', { status: 'waiting_input' });
  assert.deepEqual(getJob(db, 'new'), {
    id: 'new', action: 'deploy', input: { ticket: 'GCD-1' }, status: 'waiting_input', channelId: 'C1', threadTs: '1.1', userId: 'U1', announced: true
  });
  updateJob(db, 'new', { status: 'failed' });
  assert.equal(findActiveJobByThread(db, 'C1', '1.1'), null);
  fs.rmSync(directory, { recursive: true, force: true });
});
