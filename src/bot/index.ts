import { App } from '@slack/bolt';
import type { Logger } from '@slack/bolt';
import { config, assertBotConfig, isAuthorized } from '../config.ts';
import * as registry from '../actions/index.ts';
import { createQueue, createQueueEvents } from '../shared/queue.ts';
import type { CommandQueue } from '../shared/queue.ts';
import { createBus } from '../shared/bus.ts';
import { createDatabase, updateJob, getJob, findActiveJobByThread, findWaitingJobInChannel, maxJobNumber } from '../shared/db.ts';
import { createCommands, parseCancel, toPlainText } from './commands.ts';
import { enqueueJob, toJobId, jobLabel, runningMessage } from './jobs.ts';
import { createLogStreams } from './logStream.ts';
import type { Action, BusEvent, JobInput, JobRecord, JobResult } from '../types.ts';

type Reply = (text: string) => Promise<unknown>;
// Where a user typed something: a conversation, plus the thread inside it (undefined = top level / DM).
type Place = { channel: string; threadTs?: string };
// What onFinished needs: a full worker result, or just the failure reason when the processor threw.
type Outcome = Pick<JobResult, 'ok' | 'exitCode' | 'reason'> & Partial<JobResult>;

const { botToken, appToken } = assertBotConfig();
const app = new App({ token: botToken, appToken, socketMode: true });
const bus = createBus();
const queues = new Map<string, CommandQueue>(registry.queueGroups.map((group) => [group.name, createQueue(group.name)]));
const { parseCommand, helpText } = createCommands(registry.actions);
const logs = createLogStreams(app.client);
const db = await createDatabase(config.databasePath);

const ACTIVE_STATUSES = ['queued', 'running', 'waiting_input'];

function truncate(value: string | null | undefined, max = 2500): string {
  const text = String(value || '').trim();
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function postToThread(job: JobRecord, text: string): Promise<unknown> {
  return app.client.chat.postMessage({ channel: job.channelId, thread_ts: job.threadTs, text }).catch(console.error);
}

async function newJobId(): Promise<string> {
  return toJobId(await bus.nextJobNumber());
}

function queueFor(action: Action): CommandQueue {
  const queue = queues.get(action.queue.name);
  if (!queue) throw new Error(`No queue for action ${action.name}`);
  return queue;
}

async function enqueue(action: Action, input: JobInput, slack: { channelId: string; userId: string; replyThreadTs?: string; jobId?: string }) {
  const jobId = slack.jobId || await newJobId();
  return enqueueJob({ client: app.client, db, queue: queueFor(action), action, input, ...slack, jobId });
}

// --- Incoming Slack messages -------------------------------------------------------------------

async function runChatCommand({ text, channel, user, reply, replyThreadTs, logger }:
  { text: string | undefined; channel: string; user: string; reply: Reply; replyThreadTs?: string; logger: Logger }) {
  const parsed = parseCommand(text);
  if (!parsed) return reply(helpText());
  const { action, args } = parsed;
  if (!isAuthorized(channel, user)) return reply(`Bạn không có quyền chạy ${action.name}.`);
  let input: JobInput;
  try {
    input = action.validate(action.parse(args));
  } catch (error) {
    return reply((error as Error).message);
  }
  try {
    await enqueue(action, input, { channelId: channel, userId: user, replyThreadTs });
  } catch (error) {
    logger.error(error);
    await reply(`❌ Không thể xếp hàng ${action.name}: ${(error as Error).message}`);
  }
}

// Removes a job that no worker has picked up yet. False when a worker already started it.
async function removeQueuedJob(job: JobRecord): Promise<boolean> {
  const action = registry.getAction(job.action);
  const queued = action && await queueFor(action).getJob(job.id);
  if (!queued) return true;
  try {
    await queued.remove();
    return true;
  } catch {
    return false;
  }
}

// "cancel #N": queued jobs are removed from their queue; running/waiting jobs are killed by their worker,
// and the "#N đã bị huỷ" message then comes from onFinished. `here` is where the user typed the command,
// used to acknowledge when that is not the job's own conversation/thread.
async function cancelJob({ number, user, here, reply }: { number: number | null; user: string; here: Place; reply: Reply }) {
  if (!number) return reply('Cú pháp: `cancel #3`');
  const label = `#${number}`;
  const job = getJob(db, toJobId(number));
  if (!job) return reply(`Không tìm thấy ${label}.`);
  if (!ACTIVE_STATUSES.includes(job.status)) return reply(`${label} đã hoàn thành.`);
  if (!isAuthorized(job.channelId, user)) return reply(`Bạn không có quyền huỷ ${label}.`);
  const elsewhere = job.channelId !== here.channel || job.threadTs !== here.threadTs;
  if (job.status === 'queued' && await removeQueuedJob(job)) {
    updateJob(db, job.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    await postToThread(job, `${label} đã bị huỷ bởi <@${user}>`);
    if (elsewhere) await reply(`${label} đã bị huỷ.`);
    return;
  }
  const receivers = await bus.sendCancel(job.id, user);
  if (!receivers) return reply(`⚠️ Không có worker nào đang chạy ${label}.`);
  if (elsewhere) await reply(`Đang huỷ ${label}…`);
}

// Returns true when the text was a cancel command (handled), so callers skip their normal routing.
async function tryCancel({ text, user, here, reply }: { text: string | undefined; user: string; here: Place; reply: Reply }): Promise<boolean> {
  const parsed = parseCancel(text);
  if (!parsed) return false;
  await cancelJob({ number: parsed.number, user, here, reply });
  return true;
}

// A reply in a running job's thread is the answer to the command's prompt: pass it to the worker's stdin.
// On success nothing is posted; the answer shows up in the live log (see 'input-received').
async function forwardInput({ job, text, user, reply }: { job: JobRecord; text: string | undefined; user: string; reply: Reply }) {
  if (!isAuthorized(job.channelId, user)) return reply('Bạn không có quyền trả lời job này.');
  if (job.status === 'queued') return reply(`⏸ ${jobLabel(job.id)} chưa chạy nên chưa thể nhận câu trả lời.`);
  const receivers = await bus.sendInput(job.id, toPlainText(text));
  if (!receivers) return reply(`⚠️ Không có worker nào đang chạy ${jobLabel(job.id)}.`);
}

app.message(async ({ message, say, context, logger }) => {
  if (message.subtype !== undefined || message.bot_id) return;
  const { text, user, channel } = message;
  if (message.channel_type === 'im') {
    // DMs are one flat conversation: reply top-level; while a job waits for input, the next message is its answer.
    const replyDirect: Reply = (reply) => say({ text: reply });
    if (await tryCancel({ text, user, here: { channel }, reply: replyDirect })) return;
    const waiting = findWaitingJobInChannel(db, channel);
    if (waiting) return void await forwardInput({ job: waiting, text, user, reply: replyDirect });
    return void await runChatCommand({ text, channel, user, reply: replyDirect, logger });
  }
  // Channel messages: only thread replies to an active job. Messages that @mention the bot go to app_mention.
  const threadTs = message.thread_ts;
  const job = threadTs ? findActiveJobByThread(db, channel, threadTs) : null;
  if (!job || String(text).includes(`<@${context.botUserId}>`)) return;
  const reply: Reply = (replyText) => say({ text: replyText, thread_ts: threadTs });
  if (await tryCancel({ text, user, here: { channel, threadTs }, reply })) return;
  await forwardInput({ job, text, user, reply });
});

app.event('app_mention', async ({ event, say, logger }) => {
  const user = event.user ?? '';
  const replyThreadTs = event.thread_ts || event.ts;
  const reply: Reply = (text) => say({ text, thread_ts: replyThreadTs });
  if (await tryCancel({ text: event.text, user, here: { channel: event.channel, threadTs: replyThreadTs }, reply })) return;
  const job = event.thread_ts ? findActiveJobByThread(db, event.channel, event.thread_ts) : null;
  if (job) return void await forwardInput({ job, text: event.text, user, reply });
  await runChatCommand({ text: event.text, channel: event.channel, user, reply, replyThreadTs, logger });
});

for (const action of registry.actions) {
  if (!action.slashCommand) continue;
  app.command(action.slashCommand, async ({ command, ack, logger }) => {
    if (!isAuthorized(command.channel_id, command.user_id)) {
      await ack({ response_type: 'ephemeral', text: `Bạn không có quyền chạy ${action.name}.` });
      return;
    }
    let input: JobInput;
    try {
      input = action.validate(action.parse(command.text));
    } catch (error) {
      await ack({ response_type: 'ephemeral', text: (error as Error).message });
      return;
    }
    const jobId = await newJobId();
    await ack({ response_type: 'ephemeral', text: `Đã nhận yêu cầu ${action.name} ${jobLabel(jobId)}.` });
    await enqueue(action, input, { channelId: command.channel_id, userId: command.user_id, jobId })
      .catch((error) => logger.error(error));
  });
}

// --- Job progress (BullMQ events + live events from workers) -----------------------------------

async function onActive(jobId: string): Promise<void> {
  const job = getJob(db, jobId);
  if (!job) return;
  updateJob(db, jobId, { status: 'running', startedAt: new Date().toISOString(), announced: 1 });
  // Jobs that had to wait were announced as "Đã thêm … vào hàng đợi"; say they are running now.
  const action = registry.getAction(job.action);
  if (!job.announced && action) await postToThread(job, runningMessage(jobId, action, job.input));
  await logs.start(job);
}

async function onFinished(jobId: string, result: Outcome): Promise<void> {
  const job = getJob(db, jobId);
  if (!job) return;
  updateJob(db, jobId, {
    status: result.ok ? 'succeeded' : result.cancelled ? 'cancelled' : 'failed',
    finishedAt: result.finishedAt || new Date().toISOString(),
    exitCode: result.exitCode,
    outputSummary: truncate(result.stdoutTail),
    errorSummary: truncate(result.reason || result.stderrTail)
  });
  await logs.finish(jobId);
  if (result.ok) {
    await postToThread(job, `${jobLabel(jobId)} hoàn tất`);
    return;
  }
  if (result.cancelled) {
    await postToThread(job, `${jobLabel(jobId)} đã bị huỷ${result.cancelledBy ? ` bởi <@${result.cancelledBy}>` : ''}`);
    return;
  }
  // Output is already in the live log; only add the reason when the runner stopped the command itself.
  const detail = result.reason ? `: ${truncate(result.reason, 500)}` : ` (exit code: ${result.exitCode ?? 'n/a'})`;
  await postToThread(job, `${jobLabel(jobId)} thất bại${detail}`);
}

async function onBusEvent(event: BusEvent): Promise<void> {
  const job = getJob(db, event.jobId);
  if (!job) return;
  switch (event.type) {
    case 'output':
      logs.append(job, event.text);
      break;
    case 'prompt':
      updateJob(db, job.id, { status: 'waiting_input' });
      await postToThread(job, `❓ ${event.text}`);
      break;
    case 'input-received':
      // Piped stdin is not echoed by the command, so show the answer in the log like a terminal would.
      logs.append(job, `${event.text}\n`);
      break;
    case 'prompt-closed':
      updateJob(db, job.id, { status: 'running' });
      break;
  }
}

for (const group of registry.queueGroups) {
  const events = createQueueEvents(group.name);
  events.on('active', ({ jobId }) => onActive(jobId).catch(console.error));
  // QueueEvents delivers the worker's return value already JSON-parsed, despite its string typing.
  events.on('completed', ({ jobId, returnvalue }) => onFinished(jobId, returnvalue as unknown as JobResult).catch(console.error));
  events.on('failed', ({ jobId, failedReason }) => onFinished(jobId, { ok: false, exitCode: null, reason: failedReason }).catch(console.error));
}

app.error(async (error) => console.error(error));

await bus.ensureJobNumberAtLeast(maxJobNumber(db));
await bus.subscribeEvents((event) => void onBusEvent(event).catch(console.error));
await app.start();
console.log(`⚡ Slack bot is running in Socket Mode (actions: ${registry.actions.map((action) => action.name).join(', ')})`);
