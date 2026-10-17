const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase, insertJob, updateJob, getJob, findActiveJobByThread, maxJobNumber } = require('../src/shared/db');

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
    id: 'new', action: 'deploy', input: { ticket: 'GCD-1' }, status: 'waiting_input', channelId: 'C1', threadTs: '1.1', userId: 'U1'
  });
  updateJob(db, 'new', { status: 'failed' });
  assert.equal(findActiveJobByThread(db, 'C1', '1.1'), null);
  fs.rmSync(directory, { recursive: true, force: true });
});
