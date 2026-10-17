import { Redis } from 'ioredis';
import { config } from '../config.ts';
import { connection } from './queue.ts';
import type { BusEvent } from '../types.ts';

// Fire-and-forget Redis pub/sub between bot and workers:
// worker → bot: live job events (output, prompt, ...); bot → worker: answers typed into a job's thread.
const eventsChannel = () => `${config.queuePrefix}:events`;
const inputChannel = (jobId: string) => `${config.queuePrefix}:input:${jobId}`;
const jobSequenceKey = () => `${config.queuePrefix}:job-seq`;

type InputMessage = { text: string; cancel?: undefined } | { cancel: true; by: string };

export function createBus() {
  const publisher = new Redis(connection);
  const handlers = new Map<string, (message: never) => void>();
  let subscriber: Redis | undefined;

  function getSubscriber(): Redis {
    if (!subscriber) {
      subscriber = new Redis(connection);
      subscriber.on('message', (channel: string, message: string) => {
        const handler = handlers.get(channel);
        if (!handler) return;
        try {
          handler(JSON.parse(message) as never);
        } catch (error) {
          console.error(`[bus] bad message on ${channel}:`, error);
        }
      });
    }
    return subscriber;
  }

  async function listen<T>(channel: string, handler: (message: T) => void): Promise<() => Promise<void>> {
    handlers.set(channel, handler);
    const client = getSubscriber();
    await client.subscribe(channel);
    return async () => {
      handlers.delete(channel);
      await client.unsubscribe(channel);
    };
  }

  return {
    publishEvent: (event: BusEvent) => publisher.publish(eventsChannel(), JSON.stringify(event)),
    subscribeEvents: (handler: (event: BusEvent) => void) => listen(eventsChannel(), handler),
    // Resolves to the number of workers that received the input (0 = nobody is running this job).
    sendInput: (jobId: string, text: string) => publisher.publish(inputChannel(jobId), JSON.stringify({ text })),
    // Same channel also carries cancel requests ({ cancel: true, by }), so a worker only listens once per job.
    sendCancel: (jobId: string, by: string) => publisher.publish(inputChannel(jobId), JSON.stringify({ cancel: true, by })),
    subscribeInput: (jobId: string, onInput: (text: string) => void, onCancel: (request: { by: string }) => void = () => {}) =>
      listen<InputMessage>(inputChannel(jobId), (message) => (message.cancel ? onCancel(message) : onInput(message.text))),
    // Job numbers (#1, #2, …) come from a Redis counter shared by every bot instance.
    nextJobNumber: () => publisher.incr(jobSequenceKey()),
    // Keeps the counter ahead of jobs already recorded, e.g. after the Redis data was wiped.
    async ensureJobNumberAtLeast(number: number): Promise<void> {
      if (Number(await publisher.get(jobSequenceKey())) < number) await publisher.set(jobSequenceKey(), number);
    },
    close(): void {
      publisher.disconnect();
      subscriber?.disconnect();
    }
  };
}

export type Bus = ReturnType<typeof createBus>;
