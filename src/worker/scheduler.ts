import { runCommand } from './runner.ts';
import type { RunningCommand } from './runner.ts';
import type { Command, JobInput, JobResult, QueueGroup, RunnerEvent } from '../types.ts';

export interface ScheduledJob {
  id: string;
  command: Command;
  input: JobInput;
}

export interface SchedulerOptions {
  groups: QueueGroup[];
  inputTimeoutMs?: number;
  // Awaited before the command spawns, so "#N Running" / the log message come before any output.
  onStart(job: ScheduledJob): Promise<void>;
  onEvent(jobId: string, event: RunnerEvent): void;
  // Awaited before the slot is freed, so a job's completion is reported before the next job on its queue starts.
  onFinish(jobId: string, result: JobResult): Promise<void>;
}

interface GroupState {
  concurrency: number;
  waiting: ScheduledJob[];
  // Reserved as soon as a job is taken (run is null until its command has spawned) and kept until its
  // completion has been reported; `done` marks that the command itself has ended.
  active: Map<string, { job: ScheduledJob; run: RunningCommand | null; done: boolean }>;
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

  // The queue whose slot holds this job while its command can still be reached (not yet ended).
  function stateOf(jobId: string): GroupState | undefined {
    return [...states.values()].find((state) => {
      const entry = state.active.get(jobId);
      return entry !== undefined && !entry.done;
    });
  }

  async function execute(state: GroupState, job: ScheduledJob): Promise<JobResult> {
    await onStart(job);
    let run: RunningCommand;
    try {
      const { file, args } = job.command.build(job.command.validate(job.input));
      run = runCommand({
        file,
        args,
        timeoutMs: job.command.timeoutMs,
        inputTimeoutMs,
        promptPatterns: job.command.promptPatterns,
        onEvent: (event) => onEvent(job.id, event)
      });
    } catch (error) {
      return failure((error as Error).message);
    }
    state.active.set(job.id, { job, run, done: false });
    // A cancel that arrived while onStart was still running.
    if (cancelledBy.has(job.id)) run.kill('Job cancelled.');
    const result = await run.result;
    return { ...result, cancelledBy: result.cancelled ? cancelledBy.get(job.id) : undefined, finishedAt: new Date().toISOString() };
  }

  function pump(state: GroupState): void {
    while (state.active.size < state.concurrency && state.waiting.length) {
      const job = state.waiting.shift()!;
      state.active.set(job.id, { job, run: null, done: false });
      execute(state, job)
        .catch((error: Error) => failure(error.message))
        .then((result) => {
          const entry = state.active.get(job.id);
          if (entry) entry.done = true;
          return onFinish(job.id, result);
        })
        // A failed report (e.g. Slack down) must not block the queue.
        .catch((error) => console.error(error))
        .finally(() => {
          state.active.delete(job.id);
          cancelledBy.delete(job.id);
          pump(state);
        });
    }
  }

  return {
    enqueue(job: ScheduledJob): void {
      const state = stateFor(job.command.queue.name);
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
      state.active.get(jobId)?.run?.kill('Job cancelled.');
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
