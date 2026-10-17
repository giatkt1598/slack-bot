import test from 'node:test';
import assert from 'node:assert/strict';
import { formatQueueStatus } from '../src/bot/queueStatus.ts';
import type { QueueSnapshot } from '../src/worker/scheduler.ts';
import type { JobRecord, JobStatus } from '../src/types.ts';
import { bundledCommand } from './helpers.ts';

const deploy = bundledCommand('deploy');
const status = bundledCommand('status');
const job = (id: string, command = deploy, ticket = 'GCD-1') => ({ id, command, input: { ticket } });

function records(statuses: Record<string, JobStatus>) {
  return (jobId: string): JobRecord | null => statuses[jobId]
    ? { id: jobId, command: 'deploy', input: {}, status: statuses[jobId], channelId: 'C1', threadTs: undefined, userId: 'U1', announced: true }
    : null;
}

test('lists running and waiting jobs per non-empty queue', () => {
  const queues: QueueSnapshot[] = [
    { name: 'deploy', concurrency: 1, active: [job('job-15')], waiting: [job('job-16', deploy, 'GCD-2'), job('job-17', deploy, 'GCD-3')] },
    { name: 'status', concurrency: 4, active: [job('job-18', status, 'GCD-9')], waiting: [] },
    { name: 'ipconfig', concurrency: 4, active: [], waiting: [] }
  ];
  const text = formatQueueStatus(queues, records({ 'job-15': 'waiting_input', 'job-16': 'queued', 'job-17': 'queued', 'job-18': 'running' }));
  assert.equal(text, [
    '📋 Queue',
    '*deploy* (sequential)',
    '• #15 `gcmd deploy --ticket GCD-1` — ❓ waiting for an answer · <@U1>',
    '• #16 `gcmd deploy --ticket GCD-2` — ⏳ queued (position 1) · <@U1>',
    '• #17 `gcmd deploy --ticket GCD-3` — ⏳ queued (position 2) · <@U1>',
    '*status* (up to 4 in parallel)',
    '• #18 `gcmd status --ticket GCD-9` — ▶️ running · <@U1>'
  ].join('\n'));
});

test('says the queue is empty when nothing runs or waits', () => {
  const queues: QueueSnapshot[] = [{ name: 'deploy', concurrency: 1, active: [], waiting: [] }];
  assert.match(formatQueueStatus(queues, records({})), /queue is empty/);
});
