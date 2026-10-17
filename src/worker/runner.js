const spawn = require('cross-spawn');
const { execFile } = require('node:child_process');

const TAIL_CHARS = 4000;
const PROMPT_IDLE_MS = 500;
const KILL_GRACE_MS = 5000;

function tail(text, max = TAIL_CHARS) {
  return text.length > max ? text.slice(-max) : text;
}

function formatDuration(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)} phút` : `${Math.round(ms / 1000)} giây`;
}

// npm/.cmd shims on Windows start a grandchild node process, so kill the whole tree.
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGKILL');
}

/**
 * Runs a command with piped stdio, streaming output and detecting interactive prompts.
 * A prompt is a non-empty partial line (no trailing newline) that matches promptPatterns or stays idle
 * for PROMPT_IDLE_MS. While a prompt is open the runtime timeout is paused and inputTimeoutMs applies.
 *
 * Events passed to onEvent: output { stream, text }, prompt { text, expiresAt }, prompt-closed, input-received { text }.
 * Returns { result: Promise<{ ok, exitCode, reason, cancelled, stdoutTail, stderrTail }>, sendInput(text), kill(reason) }.
 */
function runCommand({ file, args = [], timeoutMs, inputTimeoutMs, promptPatterns = [], onEvent = () => {} }) {
  const child = spawn(file, args, { windowsHide: true, stdio: 'pipe' });
  const output = { stdout: '', stderr: '' };
  let partial = '';
  let promptOpen = false;
  let stopReason = null;
  let cancelled = false;
  let finished = false;
  let remainingMs = timeoutMs;
  let runStartedAt;
  let runTimer;
  let inputTimer;
  let idleTimer;
  let finish;

  const emit = (event) => {
    try {
      onEvent(event);
    } catch (error) {
      console.error(error);
    }
  };

  function stop(reason) {
    if (finished || stopReason) return;
    stopReason = reason;
    killTree(child);
    setTimeout(() => finish(null), KILL_GRACE_MS).unref();
  }

  function startRunTimer() {
    if (!timeoutMs) return;
    runStartedAt = Date.now();
    runTimer = setTimeout(() => stop(`Command chạy quá thời gian cho phép (${formatDuration(timeoutMs)}).`), Math.max(remainingMs, 0));
  }

  function pauseRunTimer() {
    if (!timeoutMs) return;
    clearTimeout(runTimer);
    remainingMs -= Date.now() - runStartedAt;
  }

  function openPrompt(text) {
    if (promptOpen || finished || stopReason) return;
    promptOpen = true;
    pauseRunTimer();
    if (inputTimeoutMs) {
      inputTimer = setTimeout(() => stop(`Hết thời gian chờ trả lời (${formatDuration(inputTimeoutMs)}).`), inputTimeoutMs);
    }
    const expiresAt = inputTimeoutMs ? new Date(Date.now() + inputTimeoutMs).toISOString() : null;
    emit({ type: 'prompt', text, expiresAt });
  }

  function closePrompt() {
    if (!promptOpen) return;
    promptOpen = false;
    clearTimeout(inputTimer);
    startRunTimer();
    emit({ type: 'prompt-closed' });
  }

  function onData(stream, text) {
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

  const result = new Promise((resolve) => {
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

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => onData('stdout', text));
  child.stderr.on('data', (text) => onData('stderr', text));
  child.stdin.on('error', () => {});
  startRunTimer();

  function sendInput(text) {
    if (finished || stopReason || !child.stdin.writable) return false;
    child.stdin.write(`${text}\n`);
    partial = '';
    clearTimeout(idleTimer);
    closePrompt();
    emit({ type: 'input-received', text });
    return true;
  }

  function kill(reason = 'Job đã bị huỷ.') {
    if (finished || stopReason) return;
    cancelled = true;
    stop(reason);
  }

  return { result, sendInput, kill };
}

module.exports = { runCommand, formatDuration };
