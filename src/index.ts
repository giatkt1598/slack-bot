import path from 'node:path';
import { App } from '@slack/bolt';
import type { Logger } from '@slack/bolt';
import { config, assertBotConfig, isAuthorized, canCancel } from './config.ts';
import * as registry from './commands/index.ts';
import { acquireLock } from './shared/lock.ts';
import { createDatabase, updateJob, getJob, listJobs, findActiveJobByThread, findWaitingJobInChannel, maxJobNumber } from './shared/db.ts';
import { createScheduler } from './worker/scheduler.ts';
import { createChatParser, isQueueCommand, parseCancel, toPlainText } from './bot/chat.ts';
import { formatQueueStatus, queueUserIds } from './bot/queueStatus.ts';
import { enqueueJob, toJobId, jobLabel, runningMessage, promptMessage, mentionCreator } from './bot/jobs.ts';
import { createLogStreams } from './bot/logStream.ts';
import { createUserNameResolver } from './bot/userNames.ts';
import type { Command, JobInput, JobRecord, JobResult, RunnerEvent } from './types.ts';

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
const { parseCommand, helpText } = createChatParser(registry.commands);
const logs = createLogStreams(app.client);
const db = await createDatabase(config.databasePath);
// Only one process runs (see acquireLock), so an in-memory counter seeded from the DB is enough.
let lastJobNumber = maxJobNumber(db);
const scheduler = createScheduler({
  groups: registry.queueGroups,
  inputTimeoutMs: config.inputTimeoutMs,
  onStart,
  onEvent: (jobId, event) => void onEvent(jobId, event).catch(console.error),
  onFinish: (jobId, result) => onFinish(jobId, result).catch(console.error)
});

const ACTIVE_STATUSES = ['queued', 'running', 'waiting_input'];

function truncate(value: string | null | undefined, max = 2500): string {
  const text = String(value || '').trim();
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function postToThread(job: JobRecord, text: string): Promise<unknown> {
  return app.client.chat.postMessage({ channel: job.channelId, thread_ts: job.threadTs, text }).catch(console.error);
}

const resolveUserName = createUserNameResolver(app.client);

const newJobId = () => toJobId(++lastJobNumber);

function enqueue(command: Command, input: JobInput, slack: { channelId: string; userId: string; replyThreadTs?: string; jobId?: string }) {
  return enqueueJob({ client: app.client, db, scheduler, command, input, ...slack, jobId: slack.jobId || newJobId() });
}

// --- Incoming Slack messages -------------------------------------------------------------------

async function runChatCommand({ text, channel, user, reply, replyThreadTs, logger }:
  { text: string | undefined; channel: string; user: string; reply: Reply; replyThreadTs?: string; logger: Logger }) {
  const parsed = parseCommand(text);
  if (!parsed) return reply(helpText());
  const { command, args } = parsed;
  if (!isAuthorized(channel, user)) return reply(`You are not allowed to run ${command.name}.`);
  let input: JobInput;
  try {
    input = command.validate(command.parse(args));
  } catch (error) {
    return reply((error as Error).message);
  }
  try {
    await enqueue(command, input, { channelId: channel, userId: user, replyThreadTs });
  } catch (error) {
    logger.error(error);
    await reply(`❌ Could not queue ${command.name}: ${(error as Error).message}`);
  }
}

// "cancel #N": queued jobs are dropped from the queue; running/waiting jobs are killed, and the
// "#N cancelled" message then comes from onFinish. `here` is where the user typed the command,
// used to acknowledge when that is not the job's own conversation/thread.
async function cancelJob({ number, user, here, reply }: { number: number | null; user: string; here: Place; reply: Reply }) {
  if (!number) return reply('Usage: `cancel #3`');
  const label = `#${number}`;
  const job = getJob(db, toJobId(number));
  if (!job) return reply(`${label} not found.`);
  if (!ACTIVE_STATUSES.includes(job.status)) return reply(`${label} has already finished.`);
  if (!canCancel(user, job)) return reply(`You are not allowed to cancel ${label}.`);
  const elsewhere = job.channelId !== here.channel || job.threadTs !== here.threadTs;
  if (scheduler.removeQueued(job.id)) {
    updateJob(db, job.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    // Tell the creator when somebody else cancelled their job (in a channel; a DM already is the creator's own).
    await postToThread(job, `${user === job.userId ? '' : mentionCreator(job)}${label} cancelled by <@${user}>`);
    if (elsewhere) await reply(`${label} cancelled.`);
    return;
  }
  if (!scheduler.cancel(job.id, user)) return reply(`⚠️ ${label} is no longer running.`);
  if (elsewhere) await reply(`Cancelling ${label}…`);
}

// Built-in bot commands (`cancel #N`, `queue`) are checked before anything else, so they work even while a
// job waits for an answer. Returns true when the text was one (handled), so callers skip their normal routing.
async function tryBuiltinCommand({ text, user, here, reply }: { text: string | undefined; user: string; here: Place; reply: Reply }): Promise<boolean> {
  if (isQueueCommand(text)) {
    if (!isAuthorized(here.channel, user)) {
      await reply('You are not allowed to view the queue.');
      return true;
    }
    const snapshot = scheduler.snapshot();
    const lookup = (jobId: string) => getJob(db, jobId);
    const names = new Map(await Promise.all(queueUserIds(snapshot, lookup).map(async (id) => [id, await resolveUserName(id)] as const)));
    await reply(formatQueueStatus(snapshot, lookup, (id) => names.get(id) ?? id));
    return true;
  }
  const parsed = parseCancel(text);
  if (!parsed) return false;
  await cancelJob({ number: parsed.number, user, here, reply });
  return true;
}

// A reply in a running job's thread is the answer to the command's prompt: write it to the command's stdin.
// On success nothing is posted; the answer shows up in the live log (see 'input-received').
async function forwardInput({ job, text, user, reply }: { job: JobRecord; text: string | undefined; user: string; reply: Reply }) {
  if (!isAuthorized(job.channelId, user)) return reply('You are not allowed to answer this job.');
  if (job.status === 'queued') return reply(`⏸ ${jobLabel(job.id)} has not started yet, so it cannot take an answer.`);
  if (!scheduler.sendInput(job.id, toPlainText(text))) return reply(`⚠️ ${jobLabel(job.id)} is no longer running.`);
}

app.message(async ({ message, say, context, logger }) => {
  if (message.subtype !== undefined || message.bot_id) return;
  const { text, user, channel } = message;
  if (message.channel_type === 'im') {
    // DMs are one flat conversation: reply top-level; while a job waits for input, the next message is its answer.
    const replyDirect: Reply = (reply) => say({ text: reply });
    if (await tryBuiltinCommand({ text, user, here: { channel }, reply: replyDirect })) return;
    const waiting = findWaitingJobInChannel(db, channel);
    if (waiting) return void await forwardInput({ job: waiting, text, user, reply: replyDirect });
    return void await runChatCommand({ text, channel, user, reply: replyDirect, logger });
  }
  // Channel messages: only thread replies to an active job. Messages that @mention the bot go to app_mention.
  const threadTs = message.thread_ts;
  const job = threadTs ? findActiveJobByThread(db, channel, threadTs) : null;
  if (!job || String(text).includes(`<@${context.botUserId}>`)) return;
  const reply: Reply = (replyText) => say({ text: replyText, thread_ts: threadTs });
  if (await tryBuiltinCommand({ text, user, here: { channel, threadTs }, reply })) return;
  await forwardInput({ job, text, user, reply });
});

app.event('app_mention', async ({ event, say, logger }) => {
  const user = event.user ?? '';
  const replyThreadTs = event.thread_ts || event.ts;
  const reply: Reply = (text) => say({ text, thread_ts: replyThreadTs });
  if (await tryBuiltinCommand({ text: event.text, user, here: { channel: event.channel, threadTs: replyThreadTs }, reply })) return;
  const job = event.thread_ts ? findActiveJobByThread(db, event.channel, event.thread_ts) : null;
  if (job) return void await forwardInput({ job, text: event.text, user, reply });
  await runChatCommand({ text: event.text, channel: event.channel, user, reply, replyThreadTs, logger });
});

// --- Job progress (scheduler callbacks) --------------------------------------------------------

async function onStart({ id: jobId }: { id: string }): Promise<void> {
  const job = getJob(db, jobId);
  if (!job) return;
  updateJob(db, jobId, { status: 'running', startedAt: new Date().toISOString(), announced: 1 });
  // Jobs that had to wait were announced as "Added … to the queue"; say they are running now.
  const command = registry.getCommand(job.command);
  if (!job.announced && command) await postToThread(job, runningMessage(jobId, command, job.input));
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
  // In channels the creator is @mentioned so they are notified (DMs need none).
  if (result.ok) {
    await postToThread(job, `${mentionCreator(job)}${jobLabel(jobId)} completed`);
    return;
  }
  if (result.cancelled) {
    // Their own cancel needs no mention; somebody else's does.
    const mention = result.cancelledBy && result.cancelledBy !== job.userId ? mentionCreator(job) : '';
    await postToThread(job, `${mention}${jobLabel(jobId)} cancelled${result.cancelledBy ? ` by <@${result.cancelledBy}>` : ''}`);
    return;
  }
  // Output is already in the live log; only add the reason when the runner stopped the command itself.
  const detail = result.reason ? `: ${truncate(result.reason, 500)}` : ` (exit code: ${result.exitCode ?? 'n/a'})`;
  await postToThread(job, `${mentionCreator(job)}${jobLabel(jobId)} failed${detail}`);
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
    const reason = 'Interrupted because the bot restarted.';
    updateJob(db, job.id, { status: 'failed', finishedAt: new Date().toISOString(), errorSummary: reason });
    await postToThread(job, `${mentionCreator(job)}${jobLabel(job.id)} failed: ${reason}`);
  }
  for (const job of listJobs(db, ['queued'])) {
    // UUID ids come from the first version, whose queue no longer exists; never start those stale jobs.
    if (!/^job-\d+$/.test(job.id)) {
      updateJob(db, job.id, { status: 'cancelled', finishedAt: new Date().toISOString(), errorSummary: 'Legacy job (from before #N numbering); not re-run.' });
      continue;
    }
    const command = registry.getCommand(job.command);
    if (command) {
      scheduler.enqueue({ id: job.id, command, input: job.input });
    } else {
      updateJob(db, job.id, { status: 'failed', finishedAt: new Date().toISOString(), errorSummary: `Unknown command: ${job.command}` });
    }
  }
}

app.error(async (error) => console.error(error));

await app.start();
await recoverJobs();
console.log(`⚡ Slack bot is running in Socket Mode (commands: ${registry.commands.map((command) => command.name).join(', ')})`);
