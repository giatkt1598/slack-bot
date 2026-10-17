const { Queue, QueueEvents } = require('bullmq');
const { config } = require('../config');

const connection = {
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null
};

function queueName(name) {
  return `${config.queuePrefix}-${name}`;
}

function createQueue(name) {
  return new Queue(queueName(name), { connection });
}

function createQueueEvents(name) {
  return new QueueEvents(queueName(name), { connection });
}

module.exports = { connection, queueName, createQueue, createQueueEvents };
