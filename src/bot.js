const crypto = require('node:crypto');
const { App } = require('@slack/bolt');
const { config, assertBotConfig } = require('./config');
const { createQueue, createQueueEvents } = require('./queue');
const { createDatabase, insertJob, updateJob } = require('./db');
const { actions } = require('./actions');

assertBotConfig();
const app = new App({ token: config.slackBotToken, appToken: config.slackAppToken, socketMode: true });
const queue = createQueue();
const queueEvents = createQueueEvents();
let db;

function isAuthorized(command) {
  const channelOk = !config.authorizedChannelIds.length || config.authorizedChannelIds.includes(command.channel_id);
  const userOk = !config.authorizedUserIds.length || config.authorizedUserIds.includes(command.user_id);
  return channelOk && userOk;
}

function truncate(value, max = 2500) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function postStatus(channel, threadTs, text) {
  await app.client.chat.postMessage({ channel, thread_ts: threadTs, text });
}

app.command('/deploy', async ({ command, ack, logger }) => {
  const jobId = crypto.randomUUID();
  if (!isAuthorized(command)) {
    await ack({ response_type: 'ephemeral', text: 'Bạn không có quyền chạy deploy.' });
    return;
  }
  const ticket = command.text.trim();
  try {
    const input = actions.deploy.validate({ ticket });
    await ack({ response_type: 'ephemeral', text: `Đã nhận yêu cầu deploy ${ticket}. Job: ${jobId}` });
    const root = await app.client.chat.postMessage({
      channel: command.channel_id,
      text: `🚀 Deploy ${ticket} đang được xếp hàng…\nJob: ${jobId} · Người chạy: <@${command.user_id}>`
    });
    const threadTs = root.ts;
    insertJob(db, {
      id: jobId,
      action: 'deploy',
      inputJson: JSON.stringify(input),
      channelId: command.channel_id,
      threadTs,
      userId: command.user_id,
      createdAt: new Date().toISOString()
    });
    await queue.add('deploy', {
      action: 'deploy',
      input,
      slack: { channelId: command.channel_id, threadTs, userId: command.user_id }
    }, { jobId, removeOnComplete: 100, removeOnFail: 100 });
  } catch (error) {
    logger.error(error);
    if (error.message.includes('Ticket')) await ack({ response_type: 'ephemeral', text: error.message });
  }
});

queueEvents.on('active', async ({ jobId }) => {
  const job = await queue.getJob(jobId);
  if (!job) return;
  updateJob(db, jobId, { status: 'running', startedAt: new Date().toISOString() });
  await postStatus(job.data.slack.channelId, job.data.slack.threadTs, `⏳ Job ${jobId} đang chạy trên worker.`).catch(console.error);
});

queueEvents.on('completed', async ({ jobId, returnvalue }) => {
  const job = await queue.getJob(jobId);
  if (!job) return;
  const result = returnvalue || {};
  const status = result.ok ? 'succeeded' : 'failed';
  updateJob(db, jobId, {
    status,
    finishedAt: result.finishedAt || new Date().toISOString(),
    exitCode: result.exitCode,
    outputSummary: truncate(result.stdout),
    errorSummary: truncate(result.stderr)
  });
  const detail = result.ok ? truncate(result.stdout) : truncate(result.stderr || result.stdout || 'Unknown command failure');
  await postStatus(job.data.slack.channelId, job.data.slack.threadTs, `${result.ok ? '✅' : '❌'} Job ${jobId} ${result.ok ? 'hoàn tất' : 'thất bại'} (exit code: ${result.exitCode ?? 'n/a'}).\n${detail || 'Không có output.'}`).catch(console.error);
});

queueEvents.on('failed', async ({ jobId, failedReason }) => {
  const job = await queue.getJob(jobId);
  if (!job) return;
  updateJob(db, jobId, { status: 'failed', finishedAt: new Date().toISOString(), errorSummary: truncate(failedReason) });
  await postStatus(job.data.slack.channelId, job.data.slack.threadTs, `❌ Job ${jobId} thất bại: ${failedReason}`).catch(console.error);
});

app.error((error) => console.error(error));

(async () => {
  db = await createDatabase(config.databasePath);
  await app.start();
  console.log('⚡ Slack bot is running in Socket Mode');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
