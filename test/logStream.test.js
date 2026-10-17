const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogStreams, render, stripAnsi } = require('../src/bot/logStream');

function fakeClient() {
  const calls = [];
  return {
    calls,
    chat: {
      postMessage: async (message) => { calls.push(['post', message]); return { ts: '100.1' }; },
      update: async (message) => { calls.push(['update', message]); return {}; }
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
  assert.match(client.calls[2][1].text, /đã kết thúc/);
  assert.ok(client.calls.slice(1).every(([, message]) => message.ts === '100.1'));
  assert.doesNotMatch(client.calls[2][1].text, /late output/);
});

test('render keeps only the tail and neutralises code fences', () => {
  const text = render({ text: `${'x'.repeat(5000)}\`\`\`end`, done: false });
  assert.ok(text.length < 3700);
  assert.match(text, /ʼʼʼend/);
  assert.equal(stripAnsi('\x1b[1;31mred\x1b[0m'), 'red');
});
