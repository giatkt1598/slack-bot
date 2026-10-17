import spawn from 'cross-spawn';
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ProcessSpec, RunResult, RunnerEvent } from '../types.ts';

const TAIL_CHARS = 4000;
const PROMPT_IDLE_MS = 500;
const KILL_GRACE_MS = 5000;

export interface RunOptions extends ProcessSpec {
  timeoutMs?: number;
  inputTimeoutMs?: number;
  promptPatterns?: RegExp[];
  onEvent?: (event: RunnerEvent) => void;
}

export interface RunningCommand {
  result: Promise<RunResult>;
  sendInput(text: string): boolean;
  kill(reason?: string): void;
}

function tail(text: string, max = TAIL_CHARS): string {
  return text.length > max ? text.slice(-max) : text;
}

export function formatDuration(ms: number): string {
  return ms >= 60000 ? `${Math.round(ms / 60000)} phút` : `${Math.round(ms / 1000)} giây`;
}

// npm/.cmd shims on Windows start a grandchild node process, so kill the whole tree.
function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGKILL');
}

/**
 * Runs a command with piped stdio, streaming output and detecting interactive prompts.
 * A prompt is a non-empty partial line (no trailing newline) that matches promptPatterns or stays idle
 * for PROMPT_IDLE_MS. While a prompt is open the runtime timeout is paused and inputTimeoutMs applies.
 */
export function runCommand({ file, args = [], timeoutMs, inputTimeoutMs, promptPatterns = [], onEvent = () => {} }: RunOptions): RunningCommand {
  // cross-spawn: plain spawn with shell:false cannot run npm .cmd shims on Windows (Node >= 20.12).
  const child = spawn(file, args, { windowsHide: true, stdio: 'pipe' });
  const output = { stdout: '', stderr: '' };
  let partial = '';
  let promptOpen = false;
  let stopReason: string | null = null;
  let cancelled = false;
  let finished = false;
  let remainingMs = timeoutMs ?? 0;
  let runStartedAt = 0;
  let runTimer: NodeJS.Timeout | undefined;
  let inputTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let finish: (exitCode: number | null, error?: Error) => void = () => {};

  const emit = (event: RunnerEvent) => {
    try {
      onEvent(event);
    } catch (error) {
      console.error(error);
    }
  };

  function stop(reason: string): void {
    if (finished || stopReason) return;
    stopReason = reason;
    killTree(child);
    setTimeout(() => finish(null), KILL_GRACE_MS).unref();
  }

  function startRunTimer(): void {
    if (!timeoutMs) return;
    runStartedAt = Date.now();
    runTimer = setTimeout(() => stop(`Command chạy quá thời gian cho phép (${formatDuration(timeoutMs)}).`), Math.max(remainingMs, 0));
  }

  function pauseRunTimer(): void {
    if (!timeoutMs) return;
    clearTimeout(runTimer);
    remainingMs -= Date.now() - runStartedAt;
  }

  function openPrompt(text: string): void {
    if (promptOpen || finished || stopReason) return;
    promptOpen = true;
    pauseRunTimer();
    if (inputTimeoutMs) {
      inputTimer = setTimeout(() => stop(`Hết thời gian chờ trả lời (${formatDuration(inputTimeoutMs)}).`), inputTimeoutMs);
    }
    const expiresAt = inputTimeoutMs ? new Date(Date.now() + inputTimeoutMs).toISOString() : null;
    emit({ type: 'prompt', text, expiresAt });
  }

  function closePrompt(): void {
    if (!promptOpen) return;
    promptOpen = false;
    clearTimeout(inputTimer);
    startRunTimer();
    emit({ type: 'prompt-closed' });
  }

  function onData(stream: 'stdout' | 'stderr', text: string): void {
    output[stream] = tail(output[stream] + text);
    emit({ type: 'output', stream, text });
    const lastNewline = text.lastIndexOf('\n');
    partial = lastNewline === -1 ? partial + text : text.slice(lastNewline + 1);
    clearTimeout(idleTimer);
    // The command moved on to new lines without waiting for us: the prompt was a false positive.
    if (promptOpen && lastNewline !== -1) closePrompt();
    if (promptOpen || !partial.trim()) return;
    if (promptPatterns.some((pattern) => pattern.test(partial))) {
      openPrompt(partial.trim());
      return;
    }
    idleTimer = setTimeout(() => openPrompt(partial.trim()), PROMPT_IDLE_MS);
  }

  const result = new Promise<RunResult>((resolve) => {
    finish = (exitCode, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(runTimer);
      clearTimeout(inputTimer);
      clearTimeout(idleTimer);
      const reason = stopReason || (error ? error.message : null);
      resolve({ ok: !reason && exitCode === 0, exitCode, reason, cancelled, stdoutTail: output.stdout, stderrTail: output.stderr });
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (exitCode) => finish(exitCode));
  });

  // stdio: 'pipe' guarantees these streams exist.
  const stdout = child.stdout!;
  const stderr = child.stderr!;
  const stdin = child.stdin!;
  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  stdout.on('data', (text: string) => onData('stdout', text));
  stderr.on('data', (text: string) => onData('stderr', text));
  stdin.on('error', () => {});
  startRunTimer();

  function sendInput(text: string): boolean {
    if (finished || stopReason || !stdin.writable) return false;
    stdin.write(`${text}\n`);
    partial = '';
    clearTimeout(idleTimer);
    closePrompt();
    emit({ type: 'input-received', text });
    return true;
  }

  function kill(reason = 'Job đã bị huỷ.'): void {
    if (finished || stopReason) return;
    cancelled = true;
    stop(reason);
  }

  return { result, sendInput, kill };
}
