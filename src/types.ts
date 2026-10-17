// Values a user typed for an action, after parse/validate (e.g. { ticket: 'GCD-123' }).
export type JobInput = Record<string, string>;

export interface CommandSpec {
  file: string;
  args: string[];
}

export interface QueueConfig {
  name: string;
  // 1 = sequential across all workers; N = up to N jobs in parallel.
  concurrency: number;
}

// What an action file in src/actions/ exports as default.
export interface ActionDefinition {
  name: string;
  description: string;
  usage: string;
  slashCommand?: string;
  queue?: Partial<QueueConfig>;
  // Runtime limit, excluding time spent waiting for input.
  timeoutMs?: number;
  promptPatterns?: RegExp[];
  parse(argsText: string): JobInput;
  validate(input: JobInput): JobInput;
  command(input: JobInput): CommandSpec;
}

// An action after defaults are applied by the registry.
export interface Action extends ActionDefinition {
  queue: QueueConfig;
  timeoutMs: number;
  promptPatterns: RegExp[];
}

export interface QueueGroup extends QueueConfig {
  actions: string[];
}

// BullMQ job payload.
export interface JobData {
  action: string;
  input: JobInput;
  slack: { channelId: string; threadTs: string; userId: string };
}

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  reason: string | null;
  cancelled: boolean;
  stdoutTail: string;
  stderrTail: string;
}

// BullMQ job return value.
export interface JobResult extends RunResult {
  cancelledBy?: string;
  workerId: string;
  finishedAt: string;
}

export type RunnerEvent =
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'prompt'; text: string; expiresAt: string | null }
  | { type: 'prompt-closed' }
  | { type: 'input-received'; text: string };

// Live event published by a worker on the bus.
export type BusEvent = RunnerEvent & { jobId: string };

export type JobStatus = 'queued' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'cancelled';

// A job as stored in SQLite by the bot.
export interface JobRecord {
  id: string;
  action: string;
  input: JobInput;
  status: JobStatus;
  channelId: string;
  // undefined = no thread (DM conversation).
  threadTs: string | undefined;
  userId: string;
  // Whether "#N Đang chạy lệnh …" was posted.
  announced: boolean;
}
