import { Queue, QueueEvents } from 'bullmq';
import { config } from '../config.ts';
import type { JobData, JobResult } from '../types.ts';

export const connection = {
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null
};

export type CommandQueue = Queue<JobData, JobResult>;

export function queueName(name: string): string {
  return `${config.queuePrefix}-${name}`;
}

export function createQueue(name: string): CommandQueue {
  return new Queue<JobData, JobResult>(queueName(name), { connection });
}

export function createQueueEvents(name: string): QueueEvents {
  return new QueueEvents(queueName(name), { connection });
}
