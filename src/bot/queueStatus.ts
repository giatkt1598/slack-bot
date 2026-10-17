import { formatCommand, jobLabel } from './jobs.ts';
import type { QueueSnapshot } from '../worker/scheduler.ts';
import type { JobRecord } from '../types.ts';

type Lookup = (jobId: string) => JobRecord | null;

// Creators of every running or waiting job (to resolve their display names before formatting).
export function queueUserIds(queues: QueueSnapshot[], lookup: Lookup): string[] {
  const ids = queues.flatMap((queue) => [...queue.active, ...queue.waiting]).flatMap((job) => lookup(job.id)?.userId ?? []);
  return [...new Set(ids)];
}

const escapeSlack = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Reply to the `queue` bot command: every running and waiting job per queue (empty queues are left out).
// Creators are shown as plain text names, never as @mentions, so listing the queue notifies nobody.
export function formatQueueStatus(queues: QueueSnapshot[], lookup: Lookup, userName: (userId: string) => string = (id) => id): string {
  const sections = queues
    .filter((queue) => queue.active.length || queue.waiting.length)
    .map((queue) => {
      const mode = queue.concurrency === 1 ? 'sequential' : `up to ${queue.concurrency} in parallel`;
      const line = (job: QueueSnapshot['active'][number], state: string) => {
        const user = lookup(job.id)?.userId;
        return `• ${jobLabel(job.id)} \`${formatCommand(job.command.build(job.input))}\` — ${state}${user ? ` · ${escapeSlack(userName(user))}` : ''}`;
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
