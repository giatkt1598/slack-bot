const { insertJob } = require('../shared/db');

// BullMQ rejects purely numeric custom ids, so job #3 is stored as "job-3".
const toJobId = (number) => `job-${number}`;
const jobLabel = (jobId) => `#${String(jobId).replace(/^job-/, '')}`;
const formatCommand = ({ file, args }) => [file, ...args].join(' ');
// Slack DM conversation ids start with "D". DMs are one flat conversation: no threads.
const isDirectMessage = (channelId) => String(channelId).startsWith('D');

const commandText = (action, input) => `\`${formatCommand(action.command(input))}\``;
const runningMessage = (jobId, action, input) => `${jobLabel(jobId)} Đang chạy lệnh ${commandText(action, input)}`;
const queuedMessage = (jobId, action, input) => `Đã thêm ${jobLabel(jobId)} ${commandText(action, input)} vào hàng đợi`;

// True when a new job would have to wait: jobs are already waiting, or every concurrency slot is busy.
async function mustWait(queue, concurrency) {
  const counts = await queue.getJobCounts('waiting', 'prioritized', 'delayed', 'active');
  return counts.waiting + counts.prioritized + counts.delayed > 0 || counts.active >= concurrency;
}

// Posts the first message, records the job and enqueues it on the action's queue. If the job has to wait,
// the first message is "Đã thêm #N … vào hàng đợi" and "#N Đang chạy lệnh …" follows when it starts (onActive);
// otherwise "#N Đang chạy lệnh …" is posted right away.
// In channels, status updates go to replyThreadTs if given, else to the thread of the posted message.
// In DMs everything is posted top-level; the job's threadTs is '' (no thread).
async function enqueueJob({ client, db, queue, action, input, channelId, userId, replyThreadTs, jobId }) {
  const direct = isDirectMessage(channelId);
  const waits = await mustWait(queue, action.queue.concurrency);
  const root = await client.chat.postMessage({
    channel: channelId,
    thread_ts: direct ? undefined : replyThreadTs,
    text: waits ? queuedMessage(jobId, action, input) : runningMessage(jobId, action, input)
  });
  const threadTs = direct ? '' : replyThreadTs || root.ts;
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

module.exports = { enqueueJob, toJobId, jobLabel, formatCommand, isDirectMessage, runningMessage, queuedMessage, mustWait };
