import { formatCommand, jobLabel } from './jobs.ts';
import type { QueueSnapshot } from '../worker/scheduler.ts';
import type { JobRecord } from '../types.ts';

// Reply to the `queue` bot command: running and waiting jobs per queue (empty queues are left out).
export function formatQueueStatus(queues: QueueSnapshot[], lookup: (jobId: string) => JobRecord | null): string {
  const sections = queues
    .filter((queue) => queue.active.length || queue.waiting.length)
    .map((queue) => {
      const mode = queue.concurrency === 1 ? 'tuần tự' : `tối đa ${queue.concurrency} job song song`;
      const line = (job: QueueSnapshot['active'][number], state: string) => {
        const user = lookup(job.id)?.userId;
        return `• ${jobLabel(job.id)} \`${formatCommand(job.action.command(job.input))}\` — ${state}${user ? ` · <@${user}>` : ''}`;
      };
      const running = queue.active.map((job) =>
        line(job, lookup(job.id)?.status === 'waiting_input' ? '❓ đang chờ trả lời' : '▶️ đang chạy'));
      const waiting = queue.waiting.map((job, index) => line(job, `⏳ đang đợi (thứ ${index + 1})`));
      return [`*${queue.name}* (${mode})`, ...running, ...waiting].join('\n');
    });
  return sections.length
    ? `📋 Hàng đợi\n${sections.join('\n')}`
    : '📋 Hàng đợi trống: không có job nào đang chạy hoặc đang đợi.';
}
