const test = require('node:test');
const assert = require('node:assert/strict');
const { actions } = require('../src/actions');
const { toJobId, jobLabel, formatCommand } = require('../src/bot/jobs');

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
