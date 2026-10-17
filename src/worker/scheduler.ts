import { runCommand } from './runner.ts';
import type { RunningCommand } from './runner.ts';
import type { Action, JobInput, JobResult, QueueGroup, RunnerEvent } from '../types.ts';

export interface ScheduledJob {
  id: string;
  action: Action;
  input: JobInput;
}

export interface SchedulerOptions {
  groups: QueueGroup[];
  inputTimeoutMs?: number;
  // Awaited before the command spawns, so "#N Đang chạy lệnh" / the log message come before any output.
  onStart(job: ScheduledJob): Promise<void>;
  onEvent(jobId: string, event: RunnerEvent): void;
  onFinish(jobId: string, result: JobResult): void;
}

interface GroupState {
  concurrency: number;
  waiting: ScheduledJob[];
  // Reserved as soon as a job is taken (run is null until its command has spawned).
  active: Map<string, { job: ScheduledJob; run: RunningCommand | null }>;
}

export interface QueueSnapshot {
  name: string;
  concurrency: number;
  active: ScheduledJob[];
  waiting: ScheduledJob[];
}

/**
 * In-process job queue: one FIFO per queue group, at most `concurrency` jobs running per group
 * (1 = strictly sequential). Command failures, timeouts and cancels all arrive through onFinish.
 */
export function createScheduler({ groups, inputTimeoutMs, onStart, onEvent, onFinish }: SchedulerOptions) {
  const states = new Map<string, GroupState>(
    groups.map((group) => [group.name, { concurrency: group.concurrency, waiting: [], active: new Map() }])
  );
  const cancelledBy = new Map<string, string>();

  function stateFor(queueName: string): GroupState {
    const state = states.get(queueName);
    if (!state) throw new Error(`Unknown queue ${queueName}`);
    return state;
  }

  function stateOf(jobId: string): GroupState | undefined {
    return [...states.values()].find((state) => state.active.has(jobId));
  }

  async function execute(state: GroupState, job: ScheduledJob): Promise<JobResult> {
    await onStart(job);
    let run: RunningCommand;
    try {
      const { file, args } = job.action.command(job.action.validate(job.input));
      run = runCommand({
        file,
        args,
        timeoutMs: job.action.timeoutMs,
        inputTimeoutMs,
        promptPatterns: job.action.promptPatterns,
        onEvent: (event) => onEvent(job.id, event)
      });
    } catch (error) {
      return failure((error as Error).message);
    }
    state.active.set(job.id, { job, run });
    // A cancel that arrived while onStart was still running.
    if (cancelledBy.has(job.id)) run.kill('Job đã bị huỷ.');
    const result = await run.result;
    return { ...result, cancelledBy: result.cancelled ? cancelledBy.get(job.id) : undefined, finishedAt: new Date().toISOString() };
  }

  function pump(state: GroupState): void {
    while (state.active.size < state.concurrency && state.waiting.length) {
      const job = state.waiting.shift()!;
      state.active.set(job.id, { job, run: null });
      execute(state, job)
        .catch((error: Error) => failure(error.message))
        .then((result) => {
          state.active.delete(job.id);
          cancelledBy.delete(job.id);
          try {
            onFinish(job.id, result);
          } finally {
            pump(state);
          }
        });
    }
  }

  return {
    enqueue(job: ScheduledJob): void {
      const state = stateFor(job.action.queue.name);
      state.waiting.push(job);
      pump(state);
    },
    // True when a new job on this queue would have to wait: jobs are already waiting, or every slot is busy.
    mustWait(queueName: string): boolean {
      const state = stateFor(queueName);
      return state.waiting.length > 0 || state.active.size >= state.concurrency;
    },
    // Removes a job that has not started yet. False when it is running or unknown.
    removeQueued(jobId: string): boolean {
      for (const state of states.values()) {
        const index = state.waiting.findIndex((job) => job.id === jobId);
        if (index !== -1) {
          state.waiting.splice(index, 1);
          return true;
        }
      }
      return false;
    },
    // Writes an answer to a running command's stdin. False when the job is not running.
    sendInput(jobId: string, text: string): boolean {
      return stateOf(jobId)?.active.get(jobId)?.run?.sendInput(text) ?? false;
    },
    // Kills a running job (its result arrives through onFinish with cancelled: true). False when not running.
    cancel(jobId: string, by: string): boolean {
      const state = stateOf(jobId);
      if (!state) return false;
      cancelledBy.set(jobId, by);
      state.active.get(jobId)?.run?.kill('Job đã bị huỷ.');
      return true;
    },
    // Running and waiting jobs per queue, in queue order (for the `queue` bot command).
    snapshot(): QueueSnapshot[] {
      return [...states].map(([name, state]) => ({
        name,
        concurrency: state.concurrency,
        active: [...state.active.values()].map((entry) => entry.job),
        waiting: [...state.waiting]
      }));
    }
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;

function failure(reason: string): JobResult {
  return { ok: false, exitCode: null, reason, cancelled: false, stdoutTail: '', stderrTail: '', finishedAt: new Date().toISOString() };
}
