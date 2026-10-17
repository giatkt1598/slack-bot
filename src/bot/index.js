const { App } = require('@slack/bolt');
const { config, assertBotConfig, isAuthorized } = require('../config');
const registry = require('../actions');
const { createQueue, createQueueEvents } = require('../shared/queue');
const { createBus } = require('../shared/bus');
const { createDatabase, updateJob, getJob, findActiveJobByThread, maxJobNumber } = require('../shared/db');
const { createCommands, toPlainText } = require('./commands');
const { enqueueJob, toJobId, jobLabel } = require('./jobs');
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
  const reply = (text) => say({ text, thread_ts: message.thread_ts });
  const job = message.thread_ts && findActiveJobByThread(db, message.channel, message.thread_ts);
  if (message.channel_type === 'im') {
    if (job) return forwardInput({ job, text: message.text, user: message.user, reply });
    return runChatCommand({ text: message.text, channel: message.channel, user: message.user, reply, replyThreadTs: message.thread_ts, logger });
  }
  // Channel messages: only thread replies to an active job. Messages that @mention the bot go to app_mention.
  if (job && !String(message.text).includes(`<@${context.botUserId}>`)) {
    await forwardInput({ job, text: message.text, user: message.user, reply });
  }
});

app.event('app_mention', async ({ event, say, logger }) => {
  const replyThreadTs = event.thread_ts || event.ts;
  const reply = (text) => say({ text, thread_ts: replyThreadTs });
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
  updateJob(db, jobId, { status: 'running', startedAt: new Date().toISOString() });
  await logs.start(job);
}

async function onFinished(jobId, result) {
  const job = getJob(db, jobId);
  if (!job) return;
  updateJob(db, jobId, {
    status: result.ok ? 'succeeded' : 'failed',
    finishedAt: result.finishedAt || new Date().toISOString(),
    exitCode: result.exitCode,
    outputSummary: truncate(result.stdoutTail),
    errorSummary: truncate(result.reason || result.stderrTail)
  });
  await logs.finish(jobId);
  if (result.ok) return postToThread(job, `${jobLabel(jobId)} hoàn tất`);
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
