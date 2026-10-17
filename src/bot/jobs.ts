import { insertJob } from '../shared/db.ts';
import type { Database } from '../shared/db.ts';
import type { Scheduler } from '../worker/scheduler.ts';
import type { Command, ProcessSpec, JobInput } from '../types.ts';
import type { SlackClient } from './slack.ts';

// Job #3 is stored as "job-3" (the format older BullMQ-era rows use too).
export const toJobId = (number: number) => `job-${number}`;
export const jobLabel = (jobId: string) => `#${jobId.replace(/^job-/, '')}`;
export const formatCommand = ({ file, args }: ProcessSpec) => [file, ...args].join(' ');
// Slack DM conversation ids start with "D". DMs are one flat conversation: no threads.
export const isDirectMessage = (channelId: string) => channelId.startsWith('D');

const commandText = (command: Command, input: JobInput) => `\`${formatCommand(command.build(input))}\``;
export const runningMessage = (jobId: string, command: Command, input: JobInput) =>
  `${jobLabel(jobId)} Running ${commandText(command, input)}`;
export const queuedMessage = (jobId: string, command: Command, input: JobInput) =>
  `Added ${jobLabel(jobId)} ${commandText(command, input)} to the queue`;
// Names the job so answers aren't mixed up when several jobs ask at once (especially in a flat DM).
export const promptMessage = (jobId: string, prompt: string) => `❓ [${jobLabel(jobId)}] ${prompt}`;

export interface EnqueueOptions {
  client: SlackClient;
  db: Database;
  scheduler: Pick<Scheduler, 'mustWait' | 'enqueue'>;
  command: Command;
  input: JobInput;
  channelId: string;
  userId: string;
  replyThreadTs?: string;
  jobId: string;
}

// Posts the first message, records the job and enqueues it on the command's queue. If the job has to wait,
// the first message is "Added #N … to the queue" and "#N Running …" follows when it starts (onStart);
// otherwise "#N Running …" is posted right away.
// In channels, status updates go to replyThreadTs if given, else to the thread of the posted message.
// In DMs everything is posted top-level; the job's threadTs is '' (no thread).
export async function enqueueJob({ client, db, scheduler, command, input, channelId, userId, replyThreadTs, jobId }: EnqueueOptions): Promise<string> {
  const direct = isDirectMessage(channelId);
  const waits = scheduler.mustWait(command.queue.name);
  const root = await client.chat.postMessage({
    channel: channelId,
    thread_ts: direct ? undefined : replyThreadTs,
    text: waits ? queuedMessage(jobId, command, input) : runningMessage(jobId, command, input)
  });
  const threadTs = direct ? '' : replyThreadTs || root.ts || '';
  insertJob(db, {
    id: jobId,
    command: command.name,
    inputJson: JSON.stringify(input),
    channelId,
    threadTs,
    userId,
    createdAt: new Date().toISOString(),
    announced: !waits
  });
  scheduler.enqueue({ id: jobId, command, input });
  return jobId;
}
