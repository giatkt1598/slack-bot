const { App } = require('@slack/bolt');
const { config, assertBotConfig, isAuthorized } = require('../config');
const registry = require('../actions');
const { createQueue, createQueueEvents } = require('../shared/queue');
const { createBus } = require('../shared/bus');
const { createDatabase, updateJob, getJob, findActiveJobByThread, findWaitingJobInChannel, maxJobNumber } = require('../shared/db');
const { createCommands, parseCancel, toPlainText } = require('./commands');
const { enqueueJob, toJobId, jobLabel, runningMessage } = require('./jobs');
const { createLogStreams } = require('./logStream');

assertBotConfig();
const app = new App({ token: config.slackBotToken, appToken: config.slackAppToken, socketMode: true });
const bus = createBus();
const queues = new Map(registry.queueGroups.map((group) => [group.name, createQueue(group.name)]));
const { parseCommand, helpText } = createCommands(registry.actions);
const logs = createLogStreams(app.client);
let db;

function truncate(value, max = 2500) {
  const text = String(value || '').trim();
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function postToThread(job, text) {
  return app.client.chat.postMessage({ channel: job.channelId, thread_ts: job.threadTs, text }).catch(console.error);
}

async function newJobId() {
  return toJobId(await bus.nextJobNumber());
}

async function enqueue(action, input, { jobId, ...slack }) {
  const id = jobId || await newJobId();
  return enqueueJob({ client: app.client, db, queue: queues.get(action.queue.name), action, input, jobId: id, ...slack });
}

// --- Incoming Slack messages -------------------------------------------------------------------

async function runChatCommand({ text, channel, user, reply, replyThreadTs, logger }) {
  const parsed = parseCommand(text);
  if (!parsed) return reply(helpText());
  const { action, args } = parsed;
  if (!isAuthorized(channel, user)) return reply(`Bạn không có quyền chạy ${action.name}.`);
  let input;
  try {
    input = action.validate(action.parse(args));
  } catch (error) {
    return reply(error.message);
  }
  try {
    await enqueue(action, input, { channelId: channel, userId: user, replyThreadTs });
  } catch (error) {
    logger.error(error);
    await reply(`❌ Không thể xếp hàng ${action.name}: ${error.message}`);
  }
}

const ACTIVE_STATUSES = ['queued', 'running', 'waiting_input'];

// Removes a job that no worker has picked up yet. False when a worker already started it.
async function removeQueuedJob(job) {
  const action = registry.getAction(job.action);
  const queued = action && await queues.get(action.queue.name).getJob(job.id);
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
async function cancelJob({ number, user, here, reply }) {
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
async function tryCancel({ text, user, here, reply }) {
  const parsed = parseCancel(text);
  if (!parsed) return false;
  await cancelJob({ number: parsed.number, user, here, reply });
  return true;
}

// A reply in a running job's thread is the answer to the command's prompt: pass it to the worker's stdin.
// On success nothing is posted; the answer shows up in the live log (see 'input-received').
async function forwardInput({ job, text, user, reply }) {
  if (!isAuthorized(job.channelId, user)) return reply('Bạn không có quyền trả lời job này.');
  if (job.status === 'queued') return reply(`⏸ ${jobLabel(job.id)} chưa chạy nên chưa thể nhận câu trả lời.`);
  const receivers = await bus.sendInput(job.id, toPlainText(text));
  if (!receivers) return reply(`⚠️ Không có worker nào đang chạy ${jobLabel(job.id)}.`);
}

app.message(async ({ message, say, context, logger }) => {
  if (message.subtype || message.bot_id) return;
  if (message.channel_type === 'im') {
    // DMs are one flat conversation: reply top-level; while a job waits for input, the next message is its answer.
    const replyDirect = (text) => say({ text });
    if (await tryCancel({ text: message.text, user: message.user, here: { channel: message.channel }, reply: replyDirect })) return;
    const waiting = findWaitingJobInChannel(db, message.channel);
    if (waiting) return forwardInput({ job: waiting, text: message.text, user: message.user, reply: replyDirect });
    return runChatCommand({ text: message.text, channel: message.channel, user: message.user, reply: replyDirect, logger });
  }
  // Channel messages: only thread replies to an active job. Messages that @mention the bot go to app_mention.
  const reply = (text) => say({ text, thread_ts: message.thread_ts });
  const job = message.thread_ts && findActiveJobByThread(db, message.channel, message.thread_ts);
  if (job && !String(message.text).includes(`<@${context.botUserId}>`)) {
    const here = { channel: message.channel, threadTs: message.thread_ts };
    if (await tryCancel({ text: message.text, user: message.user, here, reply })) return;
    await forwardInput({ job, text: message.text, user: message.user, reply });
  }
});

app.event('app_mention', async ({ event, say, logger }) => {
  const replyThreadTs = event.thread_ts || event.ts;
  const reply = (text) => say({ text, thread_ts: replyThreadTs });
  const here = { channel: event.channel, threadTs: replyThreadTs };
  if (await tryCancel({ text: event.text, user: event.user, here, reply })) return;
  const job = event.thread_ts && findActiveJobByThread(db, event.channel, event.thread_ts);
  if (job) return forwardInput({ job, text: event.text, user: event.user, reply });
  await runChatCommand({ text: event.text, channel: event.channel, user: event.user, reply, replyThreadTs, logger });
});

for (const action of registry.actions.filter((candidate) => candidate.slashCommand)) {
  app.command(action.slashCommand, async ({ command, ack, logger }) => {
    if (!isAuthorized(command.channel_id, command.user_id)) {
      await ack({ response_type: 'ephemeral', text: `Bạn không có quyền chạy ${action.name}.` });
      return;
    }
    let input;
    try {
      input = action.validate(action.parse(command.text));
    } catch (error) {
      await ack({ response_type: 'ephemeral', text: error.message });
      return;
    }
    const jobId = await newJobId();
    await ack({ response_type: 'ephemeral', text: `Đã nhận yêu cầu ${action.name} ${jobLabel(jobId)}.` });
    await enqueue(action, input, { channelId: command.channel_id, userId: command.user_id, jobId })
      .catch((error) => logger.error(error));
  });
}

// --- Job progress (BullMQ events + live events from workers) -----------------------------------

async function onActive(jobId) {
  const job = getJob(db, jobId);
  if (!job) return;
  updateJob(db, jobId, { status: 'running', startedAt: new Date().toISOString(), announced: 1 });
  // Jobs that had to wait were announced as "Đã thêm … vào hàng đợi"; say they are running now.
  const action = registry.getAction(job.action);
  if (!job.announced && action) await postToThread(job, runningMessage(jobId, action, job.input));
  await logs.start(job);
}

async function onFinished(jobId, result) {
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
  if (result.ok) return postToThread(job, `${jobLabel(jobId)} hoàn tất`);
  if (result.cancelled) {
    return postToThread(job, `${jobLabel(jobId)} đã bị huỷ${result.cancelledBy ? ` bởi <@${result.cancelledBy}>` : ''}`);
  }
  // Output is already in the live log; only add the reason when the runner stopped the command itself.
  const detail = result.reason ? `: ${truncate(result.reason, 500)}` : ` (exit code: ${result.exitCode ?? 'n/a'})`;
  await postToThread(job, `${jobLabel(jobId)} thất bại${detail}`);
}

async function onBusEvent(event) {
  const job = getJob(db, event.jobId);
  if (!job) return;
  if (event.type === 'output') {
    logs.append(job, event.text);
  } else if (event.type === 'prompt') {
    updateJob(db, job.id, { status: 'waiting_input' });
    await postToThread(job, `❓ ${event.text}`);
  } else if (event.type === 'input-received') {
    // Piped stdin is not echoed by the command, so show the answer in the log like a terminal would.
    logs.append(job, `${event.text}\n`);
  } else if (event.type === 'prompt-closed') {
    updateJob(db, job.id, { status: 'running' });
  }
}

for (const group of registry.queueGroups) {
  const events = createQueueEvents(group.name);
  events.on('active', ({ jobId }) => onActive(jobId).catch(console.error));
  events.on('completed', ({ jobId, returnvalue }) => onFinished(jobId, returnvalue || {}).catch(console.error));
  events.on('failed', ({ jobId, failedReason }) => onFinished(jobId, { ok: false, exitCode: null, reason: failedReason }).catch(console.error));
}

app.error((error) => console.error(error));

(async () => {
  db = await createDatabase(config.databasePath);
  await bus.ensureJobNumberAtLeast(maxJobNumber(db));
  await bus.subscribeEvents((event) => onBusEvent(event).catch(console.error));
  await app.start();
  console.log(`⚡ Slack bot is running in Socket Mode (actions: ${registry.actions.map((action) => action.name).join(', ')})`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
