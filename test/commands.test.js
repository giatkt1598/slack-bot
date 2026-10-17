const test = require('node:test');
const assert = require('node:assert/strict');
const { actions } = require('../src/actions');
const { createCommands, toPlainText } = require('../src/bot/commands');

const { parseCommand, helpText } = createCommands(actions);
const parsed = (text) => {
  const result = parseCommand(text);
  return result && { name: result.action.name, args: result.args };
};

test('parses commands from mentions and DMs, with or without slash', () => {
  assert.deepEqual(parsed('<@U123> /deploy GCD-123'), { name: 'deploy', args: 'GCD-123' });
  assert.deepEqual(parsed('<@U123> deploy GCD-XXX'), { name: 'deploy', args: 'GCD-XXX' });
  assert.deepEqual(parsed('  Deploy   GCD-1 '), { name: 'deploy', args: 'GCD-1' });
  assert.deepEqual(parsed('status GCD-9'), { name: 'status', args: 'GCD-9' });
  assert.deepEqual(parsed('deploy'), { name: 'deploy', args: '' });
});

test('returns null for unknown or empty text', () => {
  for (const text of ['hello', '', undefined, '<@U123>', 'deployx GCD-1', 'please deploy GCD-1']) {
    assert.equal(parseCommand(text), null);
  }
});

test('help text lists every registered action', () => {
  const text = helpText();
  assert.match(text, /^Tôi chưa hiểu ý bạn/);
  for (const { usage } of actions) assert.ok(text.includes(usage));
});

test('toPlainText strips mentions and decodes Slack escaping', () => {
  assert.equal(toPlainText('<@U1> a &lt;b&gt; &amp; c'), 'a <b> & c');
  assert.equal(toPlainText('<@U1>'), '');
});
