import { insertJob } from '../shared/db.ts';
import type { Database } from '../shared/db.ts';
import type { Scheduler } from '../worker/scheduler.ts';
import type { Action, CommandSpec, JobInput } from '../types.ts';
import type { SlackClient } from './slack.ts';

// Job #3 is stored as "job-3" (the format older BullMQ-era rows use too).
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

export interface EnqueueOptions {
  client: SlackClient;
  db: Database;
  scheduler: Pick<Scheduler, 'mustWait' | 'enqueue'>;
  action: Action;
  input: JobInput;
  channelId: string;
  userId: string;
  replyThreadTs?: string;
  jobId: string;
}

// Posts the first message, records the job and enqueues it on the action's queue. If the job has to wait,
// the first message is "Đã thêm #N … vào hàng đợi" and "#N Đang chạy lệnh …" follows when it starts (onStart);
// otherwise "#N Đang chạy lệnh …" is posted right away.
// In channels, status updates go to replyThreadTs if given, else to the thread of the posted message.
// In DMs everything is posted top-level; the job's threadTs is '' (no thread).
export async function enqueueJob({ client, db, scheduler, action, input, channelId, userId, replyThreadTs, jobId }: EnqueueOptions): Promise<string> {
  const direct = isDirectMessage(channelId);
  const waits = scheduler.mustWait(action.queue.name);
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
  scheduler.enqueue({ id: jobId, action, input });
  return jobId;
}
