import test from 'node:test';
import assert from 'node:assert/strict';
import { formatQueueStatus } from '../src/bot/queueStatus.ts';
import type { QueueSnapshot } from '../src/worker/scheduler.ts';
import type { JobRecord, JobStatus } from '../src/types.ts';
import { bundledAction } from './helpers.ts';

const deploy = bundledAction('deploy');
const status = bundledAction('status');
const job = (id: string, action = deploy, ticket = 'GCD-1') => ({ id, action, input: { ticket } });

function records(statuses: Record<string, JobStatus>) {
  return (jobId: string): JobRecord | null => statuses[jobId]
    ? { id: jobId, action: 'deploy', input: {}, status: statuses[jobId], channelId: 'C1', threadTs: undefined, userId: 'U1', announced: true }
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
    '📋 Hàng đợi',
    '*deploy* (tuần tự)',
    '• #15 `gcmd deploy --ticket GCD-1` — ❓ đang chờ trả lời · <@U1>',
    '• #16 `gcmd deploy --ticket GCD-2` — ⏳ đang đợi (thứ 1) · <@U1>',
    '• #17 `gcmd deploy --ticket GCD-3` — ⏳ đang đợi (thứ 2) · <@U1>',
    '*status* (tối đa 4 job song song)',
    '• #18 `gcmd status --ticket GCD-9` — ▶️ đang chạy · <@U1>'
  ].join('\n'));
});

test('says the queue is empty when nothing runs or waits', () => {
  const queues: QueueSnapshot[] = [{ name: 'deploy', concurrency: 1, active: [], waiting: [] }];
  assert.match(formatQueueStatus(queues, records({})), /Hàng đợi trống/);
});
