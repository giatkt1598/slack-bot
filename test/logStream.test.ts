import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogStreams, render, stripAnsi } from '../src/bot/logStream.ts';
import type { SlackMessage } from '../src/bot/slack.ts';

type Call = ['post' | 'update', SlackMessage & { ts?: string }];

function fakeClient() {
  const calls: Call[] = [];
  return {
    calls,
    chat: {
      postMessage: async (message: SlackMessage) => { calls.push(['post', message]); return { ts: '100.1' }; },
      update: async (message: SlackMessage & { ts: string }) => { calls.push(['update', message]); return {}; }
    }
  };
}

const job = { id: 'job-1', channelId: 'C1', threadTs: '1.1' };

test('posts one log message, then edits it in place and marks it finished', async () => {
  const client = fakeClient();
  const logs = createLogStreams(client, { intervalMs: 10 });
  await logs.start(job);
  logs.append(job, 'line 1\n');
  logs.append(job, '\x1b[32mline 2\x1b[0m\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await logs.finish(job.id);
  logs.append(job, 'late output\n');

  assert.deepEqual(client.calls.map(([kind]) => kind), ['post', 'update', 'update']);
  assert.equal(client.calls[0][1].thread_ts, '1.1');
  assert.match(client.calls[1][1].text, /line 1\nline 2/);
  assert.match(client.calls[0][1].text, /^📜 \*Log #1\* \(running…\)/);
  assert.match(client.calls[2][1].text, /^📜 \*Log #1\* \(finished\)/);
  assert.ok(client.calls.slice(1).every(([, message]) => message.ts === '100.1'));
  assert.doesNotMatch(client.calls[2][1].text, /late output/);
});

test('jobs without a thread (DMs) get a top-level log message', async () => {
  const client = fakeClient();
  const logs = createLogStreams(client, { intervalMs: 10 });
  await logs.start({ id: 'job-dm', channelId: 'D1', threadTs: undefined });
  assert.equal(client.calls[0][1].thread_ts, undefined);
  assert.equal(client.calls[0][1].channel, 'D1');
});

test('render keeps only the last 10,000 characters and neutralises code fences', () => {
  const text = render({ job: { id: 'job-15' }, text: `${'x'.repeat(12_000)}\`\`\`end`, done: false });
  assert.match(text, /^📜 \*Log #15\* \(running…\)\n```\n…x/);
  assert.ok(text.length < 10_100, `message is ${text.length} characters`);
  assert.match(text, /ʼʼʼend/);
  assert.equal(stripAnsi('\x1b[1;31mred\x1b[0m'), 'red');
});

test('output up to 10,000 characters is shown in full, longer output loses only its start', () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${String(index).padStart(4, '0')}`);
  const fits = lines(1000).join('\n'); // 9,999 characters
  assert.equal(fits.length, 9999);
  const full = render({ job: { id: 'job-1' }, text: fits, done: true });
  assert.ok(full.includes('line 0000') && full.includes('line 0999'));
  assert.ok(!full.includes('…'));

  const tooLong = lines(1200).join('\n');
  const cut = render({ job: { id: 'job-1' }, text: tooLong, done: true });
  assert.ok(!cut.includes('line 0000'));
  assert.ok(cut.includes('line 1199'));
  assert.match(cut, /```\n…/);
});

test('the in-memory buffer follows the same limit', async () => {
  const client = fakeClient();
  const logs = createLogStreams(client, { intervalMs: 10 });
  await logs.start(job);
  logs.append(job, `${'a'.repeat(15_000)}\n`);
  logs.append(job, `${'b'.repeat(15_000)}\nEND\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await logs.finish(job.id);
  const last = client.calls.at(-1)![1].text;
  assert.ok(last.includes('END') && last.includes('b'.repeat(100)));
  assert.ok(!last.includes('a'.repeat(100)));
  assert.ok(last.length < 10_100);
});
