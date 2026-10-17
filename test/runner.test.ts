import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runCommand } from '../src/worker/runner.ts';
import type { RunOptions } from '../src/worker/runner.ts';
import type { RunnerEvent } from '../src/types.ts';

const mock = path.join(import.meta.dirname, '..', 'tools', 'gcmd-command', 'bin', 'gcmd.js');

// Runs the mock gcmd, answering each prompt with the next value of `answers`.
function runMock(args: string[], { answers = [] as string[], timeoutMs = 10000, inputTimeoutMs = 5000, promptPatterns = [/\[y\/n\]\s*$/i] } = {}) {
  const events: RunnerEvent[] = [];
  const pending = [...answers];
  const run = runCommand({
    file: process.execPath,
    args: [mock, ...args, '--delay', '0'],
    timeoutMs,
    inputTimeoutMs,
    promptPatterns,
    onEvent: (event) => {
      events.push(event);
      const answer = pending[0];
      if (event.type === 'prompt' && answer !== undefined) {
        pending.shift();
        setImmediate(() => run.sendInput(answer));
      }
    }
  });
  return run.result.then((result) => ({ result, events }));
}

// Runs the mock deploy directly, letting the test drive prompts/kill through onEvent.
function runDeploy(options: Pick<RunOptions, 'timeoutMs' | 'inputTimeoutMs' | 'promptPatterns'>, onPrompt: (run: ReturnType<typeof runCommand>) => void) {
  const run = runCommand({
    file: process.execPath,
    args: [mock, 'deploy', '--ticket', 'GCD-1', '--delay', '0'],
    ...options,
    onEvent: (event) => {
      if (event.type === 'prompt') onPrompt(run);
    }
  });
  return run.result;
}

const prompts = (events: RunnerEvent[]) => events.flatMap((event) => (event.type === 'prompt' ? [event.text] : []));
const outputText = (events: RunnerEvent[]) => events.flatMap((event) => (event.type === 'output' ? [event.text] : [])).join('');

test('streams output and passes answers to prompts', async () => {
  const { result, events } = await runMock(['deploy', '--ticket', 'GCD-1'], { answers: ['Y', 'hotfix'] });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(prompts(events), ['Are you sure you want to deploy GCD-1 to production? [Y/n]', 'Release note (optional):']);
  assert.match(outputText(events), /Release note: hotfix/);
  assert.match(result.stdoutTail, /Deploy GCD-1 succeeded/);
  assert.ok(events.some((event) => event.type === 'output' && event.stream === 'stderr'));
});

test('answering n cancels the deploy', async () => {
  const { result } = await runMock(['deploy', '--ticket', 'GCD-1'], { answers: ['n'] });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdoutTail, /cancelled by user/);
});

test('detects prompts by idle partial line without a pattern', async () => {
  const { result, events } = await runMock(['deploy', '--ticket', 'GCD-1'], { answers: ['y', ''], promptPatterns: [] });
  assert.equal(result.ok, true);
  assert.equal(prompts(events).length, 2);
});

test('kills the command when nobody answers in time', async () => {
  const { result, events } = await runMock(['deploy', '--ticket', 'GCD-1'], { inputTimeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /No answer received in time/);
  const prompt = events.find((event) => event.type === 'prompt');
  assert.ok(prompt?.type === 'prompt' && prompt.expiresAt);
});

test('runtime timeout excludes time spent waiting for input', async () => {
  const result = await runDeploy(
    { timeoutMs: 1000, inputTimeoutMs: 5000, promptPatterns: [/\[y\/n\]\s*$/i, /:\s*$/] },
    (run) => setTimeout(() => run.sendInput('y'), 700)
  );
  assert.equal(result.ok, true, result.reason ?? undefined);
});

test('runtime timeout kills a command that runs too long', async () => {
  const result = await runCommand({ file: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 200 }).result;
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /exceeded its time limit/);
});

test('kill() cancels a command that is waiting for input', async () => {
  const result = await runDeploy(
    { timeoutMs: 10000, inputTimeoutMs: 10000, promptPatterns: [/\[y\/n\]\s*$/i] },
    (run) => run.kill('Job cancelled.')
  );
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, 'Job cancelled.');
});

test('kill() also stops a command that is busy running', async () => {
  const run = runCommand({ file: process.execPath, args: ['-e', 'setInterval(() => console.log("tick"), 50)'], timeoutMs: 10000 });
  setTimeout(() => run.kill(), 200);
  const result = await run.result;
  assert.equal(result.cancelled, true);
  assert.match(result.stdoutTail, /tick/);
});

test('a normal finish is not marked cancelled', async () => {
  const { result } = await runMock(['status', '--ticket', 'GCD-1']);
  assert.equal(result.cancelled, false);
});

test('status runs without prompts', async () => {
  const { result, events } = await runMock(['status', '--ticket', 'GCD-1']);
  assert.equal(result.ok, true);
  assert.deepEqual(prompts(events), []);
});

test('reports a missing executable as a failed result', async () => {
  const result = await runCommand({ file: 'definitely-not-a-real-command-xyz', args: [] }).result;
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});
