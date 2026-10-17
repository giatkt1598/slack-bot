// Values a user typed for an command, after parse/validate (e.g. { ticket: 'ABC-123' }).
export type JobInput = Record<string, string>;

export interface ProcessSpec {
  file: string;
  args: string[];
}

export interface QueueConfig {
  name: string;
  // 1 = sequential across all workers; N = up to N jobs in parallel.
  concurrency: number;
}

// What an command file in src/commands/ exports as default.
export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  queue?: Partial<QueueConfig>;
  // Runtime limit, excluding time spent waiting for input.
  timeoutMs?: number;
  promptPatterns?: RegExp[];
  parse(argsText: string): JobInput;
  validate(input: JobInput): JobInput;
  build(input: JobInput): ProcessSpec;
}

// An command after defaults are applied by the registry.
export interface Command extends CommandDefinition {
  queue: QueueConfig;
  timeoutMs: number;
  promptPatterns: RegExp[];
}

export interface QueueGroup extends QueueConfig {
  commands: string[];
}

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  reason: string | null;
  cancelled: boolean;
  stdoutTail: string;
  stderrTail: string;
}

// What the scheduler reports when a job ends (success, failure, timeout or cancel).
export interface JobResult extends RunResult {
  cancelledBy?: string;
  finishedAt: string;
}

export type RunnerEvent =
  | { type: "output"; stream: "stdout" | "stderr"; text: string }
  | { type: "prompt"; text: string; expiresAt: string | null }
  | { type: "prompt-closed" }
  | { type: "input-received"; text: string };

export type JobStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled";

// A job as stored in SQLite by the bot.
export interface JobRecord {
  id: string;
  command: string;
  input: JobInput;
  status: JobStatus;
  channelId: string;
  // undefined = no thread (DM conversation).
  threadTs: string | undefined;
  userId: string;
  // Whether "#N Running …" was posted.
  announced: boolean;
}
