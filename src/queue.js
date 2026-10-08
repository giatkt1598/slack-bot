const { Queue, QueueEvents } = require('bullmq');
const { config } = require('./config');

const connection = {
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null
};

function createQueue() {
  return new Queue(config.queueName, { connection });
}

function createQueueEvents() {
  return new QueueEvents(config.queueName, { connection });
}

module.exports = { connection, createQueue, createQueueEvents };
