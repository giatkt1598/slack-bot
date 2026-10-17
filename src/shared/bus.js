const Redis = require('ioredis');
const { config } = require('../config');
const { connection } = require('./queue');

// Fire-and-forget Redis pub/sub between bot and workers:
// worker → bot: live job events (output, prompt, ...); bot → worker: answers typed into a job's thread.
const eventsChannel = () => `${config.queuePrefix}:events`;
const inputChannel = (jobId) => `${config.queuePrefix}:input:${jobId}`;
const jobSequenceKey = () => `${config.queuePrefix}:job-seq`;

function createBus() {
  const publisher = new Redis(connection);
  const handlers = new Map();
  let subscriber;

  function getSubscriber() {
    if (!subscriber) {
      subscriber = new Redis(connection);
      subscriber.on('message', (channel, message) => {
        const handler = handlers.get(channel);
        if (!handler) return;
        try {
          handler(JSON.parse(message));
        } catch (error) {
          console.error(`[bus] bad message on ${channel}:`, error);
        }
      });
    }
    return subscriber;
  }

  async function listen(channel, handler) {
    handlers.set(channel, handler);
    await getSubscriber().subscribe(channel);
    return async () => {
      handlers.delete(channel);
      await subscriber.unsubscribe(channel);
    };
  }

  return {
    publishEvent: (event) => publisher.publish(eventsChannel(), JSON.stringify(event)),
    subscribeEvents: (handler) => listen(eventsChannel(), handler),
    // Resolves to the number of workers that received the input (0 = nobody is running this job).
    sendInput: (jobId, text) => publisher.publish(inputChannel(jobId), JSON.stringify({ text })),
    subscribeInput: (jobId, handler) => listen(inputChannel(jobId), (message) => handler(message.text)),
    // Job numbers (#1, #2, …) come from a Redis counter shared by every bot instance.
    nextJobNumber: () => publisher.incr(jobSequenceKey()),
    // Keeps the counter ahead of jobs already recorded, e.g. after the Redis data was wiped.
    async ensureJobNumberAtLeast(number) {
      if (Number(await publisher.get(jobSequenceKey())) < number) await publisher.set(jobSequenceKey(), number);
    },
    close: () => {
      publisher.disconnect();
      if (subscriber) subscriber.disconnect();
    }
  };
}

module.exports = { createBus };
