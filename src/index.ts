import path from 'node:path';
import { App } from '@slack/bolt';
import type { Logger } from '@slack/bolt';
import { config, assertBotConfig, isAuthorized } from './config.ts';
import * as registry from './actions/index.ts';
import { acquireLock } from './shared/lock.ts';
import { createDatabase, updateJob, getJob, listJobs, findActiveJobByThread, findWaitingJobInChannel, maxJobNumber } from './shared/db.ts';
import { createScheduler } from './worker/scheduler.ts';
import { createCommands, parseCancel, toPlainText } from './bot/commands.ts';
import { enqueueJob, toJobId, jobLabel, runningMessage, promptMessage } from './bot/jobs.ts';
import { createLogStreams } from './bot/logStream.ts';
import type { Action, JobInput, JobRecord, JobResult, RunnerEvent } from './types.ts';

type Reply = (text: string) => Promise<unknown>;
// Where a user typed something: a conversation, plus the thread inside it (undefined = top level / DM).
type Place = { channel: string; threadTs?: string };

const { botToken, appToken } = assertBotConfig();
let releaseLock: () => void;
try {
  releaseLock = acquireLock(path.join(path.dirname(config.databasePath), 'slack-bot.lock'));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
process.on('exit', releaseLock);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));

const app = new App({ token: botToken, appToken, socketMode: true });
const { parseCommand, helpText } = createCommands(registry.actions);
const logs = createLogStreams(app.client);
const db = await createDatabase(config.databasePath);
// Only one process runs (see acquireLock), so an in-memory counter seeded from the DB is enough.
let lastJobNumber = maxJobNumber(db);
const scheduler = createScheduler({
  groups: registry.queueGroups,
  inputTimeoutMs: config.inputTimeoutMs,
  onStart,
  onEvent: (jobId, event) => void onEvent(jobId, event).catch(console.error),
  onFinish: (jobId, result) => void onFinish(jobId, result).catch(console.error)
});

const ACTIVE_STATUSES = ['queued', 'running', 'waiting_input'];

function truncate(value: string | null | undefined, max = 2500): string {
  const text = String(value || '').trim();
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function postToThread(job: JobRecord, text: string): Promise<unknown> {
  return app.client.chat.postMessage({ channel: job.channelId, thread_ts: job.threadTs, text }).catch(console.error);
}

const newJobId = () => toJobId(++lastJobNumber);

function enqueue(action: Action, input: JobInput, slack: { channelId: string; userId: string; replyThreadTs?: string; jobId?: string }) {
  return enqueueJob({ client: app.client, db, scheduler, action, input, ...slack, jobId: slack.jobId || newJobId() });
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

// "cancel #N": queued jobs are dropped from the queue; running/waiting jobs are killed, and the
// "#N đã bị huỷ" message then comes from onFinish. `here` is where the user typed the command,
// used to acknowledge when that is not the job's own conversation/thread.
async function cancelJob({ number, user, here, reply }: { number: number | null; user: string; here: Place; reply: Reply }) {
  if (!number) return reply('Cú pháp: `cancel #3`');
  const label = `#${number}`;
  const job = getJob(db, toJobId(number));
  if (!job) return reply(`Không tìm thấy ${label}.`);
  if (!ACTIVE_STATUSES.includes(job.status)) return reply(`${label} đã hoàn thành.`);
  if (!isAuthorized(job.channelId, user)) return reply(`Bạn không có quyền huỷ ${label}.`);
  const elsewhere = job.channelId !== here.channel || job.threadTs !== here.threadTs;
  if (scheduler.removeQueued(job.id)) {
    updateJob(db, job.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    await postToThread(job, `${label} đã bị huỷ bởi <@${user}>`);
    if (elsewhere) await reply(`${label} đã bị huỷ.`);
    return;
  }
  if (!scheduler.cancel(job.id, user)) return reply(`⚠️ ${label} không còn chạy.`);
  if (elsewhere) await reply(`Đang huỷ ${label}…`);
}

// Returns true when the text was a cancel command (handled), so callers skip their normal routing.
async function tryCancel({ text, user, here, reply }: { text: string | undefined; user: string; here: Place; reply: Reply }): Promise<boolean> {
  const parsed = parseCancel(text);
  if (!parsed) return false;
  await cancelJob({ number: parsed.number, user, here, reply });
  return true;
}

// A reply in a running job's thread is the answer to the command's prompt: write it to the command's stdin.
// On success nothing is posted; the answer shows up in the live log (see 'input-received').
async function forwardInput({ job, text, user, reply }: { job: JobRecord; text: string | undefined; user: string; reply: Reply }) {
  if (!isAuthorized(job.channelId, user)) return reply('Bạn không có quyền trả lời job này.');
  if (job.status === 'queued') return reply(`⏸ ${jobLabel(job.id)} chưa chạy nên chưa thể nhận câu trả lời.`);
  if (!scheduler.sendInput(job.id, toPlainText(text))) return reply(`⚠️ ${jobLabel(job.id)} không còn chạy.`);
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
    const jobId = newJobId();
    await ack({ response_type: 'ephemeral', text: `Đã nhận yêu cầu ${action.name} ${jobLabel(jobId)}.` });
    await enqueue(action, input, { channelId: command.channel_id, userId: command.user_id, jobId })
      .catch((error) => logger.error(error));
  });
}

// --- Job progress (scheduler callbacks) --------------------------------------------------------

async function onStart({ id: jobId }: { id: string }): Promise<void> {
  const job = getJob(db, jobId);
  if (!job) return;
  updateJob(db, jobId, { status: 'running', startedAt: new Date().toISOString(), announced: 1 });
  // Jobs that had to wait were announced as "Đã thêm … vào hàng đợi"; say they are running now.
  const action = registry.getAction(job.action);
  if (!job.announced && action) await postToThread(job, runningMessage(jobId, action, job.input));
  await logs.start(job);
}

async function onFinish(jobId: string, result: JobResult): Promise<void> {
  const job = getJob(db, jobId);
  if (!job) return;
  updateJob(db, jobId, {
    status: result.ok ? 'succeeded' : result.cancelled ? 'cancelled' : 'failed',
    finishedAt: result.finishedAt,
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

async function onEvent(jobId: string, event: RunnerEvent): Promise<void> {
  const job = getJob(db, jobId);
  if (!job) return;
  switch (event.type) {
    case 'output':
      logs.append(job, event.text);
      break;
    case 'prompt':
      updateJob(db, job.id, { status: 'waiting_input' });
      await postToThread(job, promptMessage(job.id, event.text));
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

// --- Startup ------------------------------------------------------------------------------------

// Commands die with the process, so jobs that were running are failed; queued jobs resume in order.
async function recoverJobs(): Promise<void> {
  for (const job of listJobs(db, ['running', 'waiting_input'])) {
    const reason = 'Bị gián đoạn do bot khởi động lại.';
    updateJob(db, job.id, { status: 'failed', finishedAt: new Date().toISOString(), errorSummary: reason });
    await postToThread(job, `${jobLabel(job.id)} thất bại: ${reason}`);
  }
  for (const job of listJobs(db, ['queued'])) {
    // UUID ids come from the first version, whose queue no longer exists; never start those stale jobs.
    if (!/^job-\d+$/.test(job.id)) {
      updateJob(db, job.id, { status: 'cancelled', finishedAt: new Date().toISOString(), errorSummary: 'Job cũ (trước khi đánh số #N), không chạy lại.' });
      continue;
    }
    const action = registry.getAction(job.action);
    if (action) {
      scheduler.enqueue({ id: job.id, action, input: job.input });
    } else {
      updateJob(db, job.id, { status: 'failed', finishedAt: new Date().toISOString(), errorSummary: `Unknown action: ${job.action}` });
    }
  }
}

app.error(async (error) => console.error(error));

await app.start();
await recoverJobs();
console.log(`⚡ Slack bot is running in Socket Mode (actions: ${registry.actions.map((action) => action.name).join(', ')})`);
