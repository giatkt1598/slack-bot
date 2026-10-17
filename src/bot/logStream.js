const MAX_CHARS = 3500;

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function render({ text, done }) {
  const body = text.length > MAX_CHARS ? `…${text.slice(-MAX_CHARS)}` : text;
  const header = done ? '📜 *Log* (đã kết thúc)' : '📜 *Log* (đang chạy…)';
  return `${header}\n\`\`\`\n${body.replace(/```/g, 'ʼʼʼ') || '(chưa có output)'}\n\`\`\``;
}

// One Slack message per job that is edited in place (throttled) as output arrives.
// Slack calls for a job are serialized through `chain` so updates never land out of order.
function createLogStreams(client, { intervalMs = 2000 } = {}) {
  const streams = new Map();
  const finished = new Set();

  function get(job) {
    let stream = streams.get(job.id);
    if (!stream) {
      stream = { job, text: '', ts: null, done: false, timer: null, chain: Promise.resolve() };
      streams.set(job.id, stream);
    }
    return stream;
  }

  function push(stream) {
    stream.chain = stream.chain.then(async () => {
      const message = { channel: stream.job.channelId, text: render(stream) };
      if (stream.ts) await client.chat.update({ ...message, ts: stream.ts });
      else stream.ts = (await client.chat.postMessage({ ...message, thread_ts: stream.job.threadTs })).ts;
    }).catch((error) => console.error(`[log ${stream.job.id}]`, error.message));
    return stream.chain;
  }

  return {
    start: (job) => (get(job).ts ? Promise.resolve() : push(get(job))),
    append(job, text) {
      // Pub/sub output can trail the BullMQ "completed" event; don't reopen a finished log.
      if (finished.has(job.id)) return;
      const stream = get(job);
      stream.text = (stream.text + stripAnsi(text)).slice(-MAX_CHARS * 2);
      if (!stream.timer) {
        stream.timer = setTimeout(() => {
          stream.timer = null;
          push(stream);
        }, intervalMs);
      }
    },
    async finish(jobId) {
      finished.add(jobId);
      if (finished.size > 1000) finished.delete(finished.values().next().value);
      const stream = streams.get(jobId);
      if (!stream) return;
      clearTimeout(stream.timer);
      stream.done = true;
      streams.delete(jobId);
      await push(stream);
    }
  };
}

module.exports = { createLogStreams, render, stripAnsi };
