import { insertJob } from '../shared/db.ts';
import type { Database } from '../shared/db.ts';
import type { CommandQueue } from '../shared/queue.ts';
import type { Action, CommandSpec, JobInput } from '../types.ts';
import type { SlackClient } from './slack.ts';

// BullMQ rejects purely numeric custom ids, so job #3 is stored as "job-3".
export const toJobId = (number: number) => `job-${number}`;
export const jobLabel = (jobId: string) => `#${jobId.replace(/^job-/, '')}`;
export const formatCommand = ({ file, args }: CommandSpec) => [file, ...args].join(' ');
// Slack DM conversation ids start with "D". DMs are one flat conversation: no threads.
export const isDirectMessage = (channelId: string) => channelId.startsWith('D');

const commandText = (action: Action, input: JobInput) => `\`${formatCommand(action.command(input))}\``;
export const runningMessage = (jobId: string, action: Action, input: JobInput) =>
  `${jobLabel(jobId)} Đang chạy lệnh ${commandText(action, input)}`;
export const queuedMessage = (jobId: string, action: Action, input: JobInput) =>
  `Đã thêm ${jobLabel(jobId)} ${commandText(action, input)} vào hàng đợi`;

type QueueLike = Pick<CommandQueue, 'add' | 'getJobCounts'>;

// True when a new job would have to wait: jobs are already waiting, or every concurrency slot is busy.
export async function mustWait(queue: Pick<CommandQueue, 'getJobCounts'>, concurrency: number): Promise<boolean> {
  const counts = await queue.getJobCounts('waiting', 'prioritized', 'delayed', 'active');
  return (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.delayed ?? 0) > 0 || (counts.active ?? 0) >= concurrency;
}

export interface EnqueueOptions {
  client: SlackClient;
  db: Database;
  queue: QueueLike;
  action: Action;
  input: JobInput;
  channelId: string;
  userId: string;
  replyThreadTs?: string;
  jobId: string;
}

// Posts the first message, records the job and enqueues it on the action's queue. If the job has to wait,
// the first message is "Đã thêm #N … vào hàng đợi" and "#N Đang chạy lệnh …" follows when it starts (onActive);
// otherwise "#N Đang chạy lệnh …" is posted right away.
// In channels, status updates go to replyThreadTs if given, else to the thread of the posted message.
// In DMs everything is posted top-level; the job's threadTs is '' (no thread).
export async function enqueueJob({ client, db, queue, action, input, channelId, userId, replyThreadTs, jobId }: EnqueueOptions): Promise<string> {
  const direct = isDirectMessage(channelId);
  const waits = await mustWait(queue, action.queue.concurrency);
  const root = await client.chat.postMessage({
    channel: channelId,
    thread_ts: direct ? undefined : replyThreadTs,
    text: waits ? queuedMessage(jobId, action, input) : runningMessage(jobId, action, input)
  });
  const threadTs = direct ? '' : replyThreadTs || root.ts || '';
  insertJob(db, {
    id: jobId,
    action: action.name,
    inputJson: JSON.stringify(input),
    channelId,
    threadTs,
    userId,
    createdAt: new Date().toISOString(),
    announced: !waits
  });
  await queue.add(action.name, {
    action: action.name,
    input,
    slack: { channelId, threadTs, userId }
  }, { jobId, removeOnComplete: 100, removeOnFail: 100 });
  return jobId;
}
