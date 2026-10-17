import { formatCommand, jobLabel } from './jobs.ts';
import type { QueueSnapshot } from '../worker/scheduler.ts';
import type { JobRecord } from '../types.ts';

// Reply to the `queue` bot command: running and waiting jobs per queue (empty queues are left out).
export function formatQueueStatus(queues: QueueSnapshot[], lookup: (jobId: string) => JobRecord | null): string {
  const sections = queues
    .filter((queue) => queue.active.length || queue.waiting.length)
    .map((queue) => {
      const mode = queue.concurrency === 1 ? 'sequential' : `up to ${queue.concurrency} in parallel`;
      const line = (job: QueueSnapshot['active'][number], state: string) => {
        const user = lookup(job.id)?.userId;
        return `• ${jobLabel(job.id)} \`${formatCommand(job.command.build(job.input))}\` — ${state}${user ? ` · <@${user}>` : ''}`;
      };
      const running = queue.active.map((job) =>
        line(job, lookup(job.id)?.status === 'waiting_input' ? '❓ waiting for an answer' : '▶️ running'));
      const waiting = queue.waiting.map((job, index) => line(job, `⏳ queued (position ${index + 1})`));
      return [`*${queue.name}* (${mode})`, ...running, ...waiting].join('\n');
    });
  return sections.length
    ? `📋 Queue\n${sections.join('\n')}`
    : '📋 The queue is empty: no running or waiting jobs.';
}
