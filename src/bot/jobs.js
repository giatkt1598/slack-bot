const { insertJob } = require('../shared/db');

// BullMQ rejects purely numeric custom ids, so job #3 is stored as "job-3".
const toJobId = (number) => `job-${number}`;
const jobLabel = (jobId) => `#${String(jobId).replace(/^job-/, '')}`;
const formatCommand = ({ file, args }) => [file, ...args].join(' ');

// Posts the "queued" message (inside replyThreadTs if given, else as a new message whose thread then
// carries all status updates), records the job and enqueues it on the action's queue.
async function enqueueJob({ client, db, queue, action, input, channelId, userId, replyThreadTs, jobId }) {
  const root = await client.chat.postMessage({
    channel: channelId,
    thread_ts: replyThreadTs,
    text: `${jobLabel(jobId)} Đang chạy lệnh \`${formatCommand(action.command(input))}\``
  });
  const threadTs = replyThreadTs || root.ts;
  insertJob(db, {
    id: jobId,
    action: action.name,
    inputJson: JSON.stringify(input),
    channelId,
    threadTs,
    userId,
    createdAt: new Date().toISOString()
  });
  await queue.add(action.name, {
    action: action.name,
    input,
    slack: { channelId, threadTs, userId }
  }, { jobId, removeOnComplete: 100, removeOnFail: 100 });
  return jobId;
}

module.exports = { enqueueJob, toJobId, jobLabel, formatCommand };
