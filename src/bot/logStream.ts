import type { JobRecord } from '../types.ts';
import { jobLabel } from './jobs.ts';
import type { SlackClient } from './slack.ts';

const MAX_CHARS = 3500;

type LogTarget = Pick<JobRecord, 'id' | 'channelId' | 'threadTs'>;

interface Stream {
  job: LogTarget;
  text: string;
  ts: string | undefined;
  done: boolean;
  timer: NodeJS.Timeout | undefined;
  chain: Promise<void>;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

export function render({ job, text, done }: { job: Pick<LogTarget, 'id'>; text: string; done: boolean }): string {
  const body = text.length > MAX_CHARS ? `…${text.slice(-MAX_CHARS)}` : text;
  const header = `📜 *Log ${jobLabel(job.id)}* ${done ? '(finished)' : '(running…)'}`;
  return `${header}\n\`\`\`\n${body.replace(/```/g, 'ʼʼʼ') || '(no output yet)'}\n\`\`\``;
}

// One Slack message per job that is edited in place (throttled) as output arrives.
// Slack calls for a job are serialized through `chain` so updates never land out of order.
export function createLogStreams(client: SlackClient, { intervalMs = 2000 } = {}) {
  const streams = new Map<string, Stream>();
  const finished = new Set<string>();

  function get(job: LogTarget): Stream {
    let stream = streams.get(job.id);
    if (!stream) {
      stream = { job, text: '', ts: undefined, done: false, timer: undefined, chain: Promise.resolve() };
      streams.set(job.id, stream);
    }
    return stream;
  }

  function push(stream: Stream): Promise<void> {
    stream.chain = stream.chain.then(async () => {
      const message = { channel: stream.job.channelId, text: render(stream) };
      if (stream.ts) await client.chat.update({ ...message, ts: stream.ts });
      else stream.ts = (await client.chat.postMessage({ ...message, thread_ts: stream.job.threadTs })).ts;
    }).catch((error: Error) => console.error(`[log ${stream.job.id}]`, error.message));
    return stream.chain;
  }

  return {
    start(job: LogTarget): Promise<void> {
      const stream = get(job);
      return stream.ts ? Promise.resolve() : push(stream);
    },
    append(job: LogTarget, text: string): void {
      // Pub/sub output can trail the BullMQ "completed" event; don't reopen a finished log.
      if (finished.has(job.id)) return;
      const stream = get(job);
      stream.text = (stream.text + stripAnsi(text)).slice(-MAX_CHARS * 2);
      if (!stream.timer) {
        stream.timer = setTimeout(() => {
          stream.timer = undefined;
          push(stream);
        }, intervalMs);
      }
    },
    async finish(jobId: string): Promise<void> {
      finished.add(jobId);
      if (finished.size > 1000) finished.delete(finished.values().next().value!);
      const stream = streams.get(jobId);
      if (!stream) return;
      clearTimeout(stream.timer);
      stream.done = true;
      streams.delete(jobId);
      await push(stream);
    }
  };
}
