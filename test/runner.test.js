const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runCommand } = require('../src/worker/runner');

const mock = path.join(__dirname, '..', 'tools', 'gcmd-command', 'bin', 'gcmd.js');

// Runs the mock gcmd, answering each prompt with the next value of `answers`.
function runMock(args, { answers = [], timeoutMs = 10000, inputTimeoutMs = 5000, promptPatterns = [/\[y\/n\]\s*$/i] } = {}) {
  const events = [];
  const pending = [...answers];
  const run = runCommand({
    file: process.execPath,
    args: [mock, ...args, '--delay', '0'],
    timeoutMs,
    inputTimeoutMs,
    promptPatterns,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'prompt' && pending.length) setImmediate(() => run.sendInput(pending.shift()));
    }
  });
  return run.result.then((result) => ({ result, events }));
}

const prompts = (events) => events.filter((event) => event.type === 'prompt').map((event) => event.text);
const outputText = (events) => events.filter((event) => event.type === 'output').map((event) => event.text).join('');

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
  assert.match(result.reason, /Hết thời gian chờ trả lời/);
  assert.ok(events.find((event) => event.type === 'prompt').expiresAt);
});

test('runtime timeout excludes time spent waiting for input', async () => {
  const run = runCommand({
    file: process.execPath,
    args: [mock, 'deploy', '--ticket', 'GCD-1', '--delay', '0'],
    timeoutMs: 1000,
    inputTimeoutMs: 5000,
    promptPatterns: [/\[y\/n\]\s*$/i, /:\s*$/],
    onEvent: (event) => {
      if (event.type === 'prompt') setTimeout(() => run.sendInput('y'), 700);
    }
  });
  const result = await run.result;
  assert.equal(result.ok, true, result.reason);
});

test('runtime timeout kills a command that runs too long', async () => {
  const run = runCommand({
    file: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    timeoutMs: 200
  });
  const result = await run.result;
  assert.equal(result.ok, false);
  assert.match(result.reason, /quá thời gian/);
});

test('kill() cancels a command that is waiting for input', async () => {
  const run = runCommand({
    file: process.execPath,
    args: [mock, 'deploy', '--ticket', 'GCD-1', '--delay', '0'],
    timeoutMs: 10000,
    inputTimeoutMs: 10000,
    promptPatterns: [/\[y\/n\]\s*$/i],
    onEvent: (event) => {
      if (event.type === 'prompt') run.kill('Job đã bị huỷ.');
    }
  });
  const result = await run.result;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, 'Job đã bị huỷ.');
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
