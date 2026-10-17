const test = require('node:test');
const assert = require('node:assert/strict');
const { actions, getAction, queueGroups, defineActions } = require('../src/actions');

const valid = {
  name: 'demo',
  description: 'Demo',
  usage: 'demo X',
  parse: (args) => ({ value: args }),
  validate: (input) => input,
  command: (input) => ({ file: 'echo', args: [input.value] })
};

test('loads the bundled actions with sequential deploy and parallel status queues', () => {
  assert.deepEqual(actions.map((action) => action.name).sort(), ['deploy', 'status']);
  assert.equal(getAction('deploy').queue.concurrency, 1);
  assert.ok(getAction('status').queue.concurrency > 1);
  assert.deepEqual(queueGroups.map((group) => group.name).sort(), ['deploy', 'status']);
});

test('bundled actions build argument arrays without a shell', () => {
  for (const action of actions) {
    const input = action.validate(action.parse('GCD-123'));
    const { file, args } = action.command(input);
    assert.equal(typeof file, 'string');
    assert.ok(Array.isArray(args));
    assert.ok(args.includes('GCD-123'));
    assert.throws(() => action.validate(action.parse('GCD-1; whoami')));
  }
});

test('applies defaults: own queue, concurrency 1, no prompt patterns', () => {
  const registry = defineActions([valid]);
  assert.deepEqual(registry.getAction('demo').queue, { name: 'demo', concurrency: 1 });
  assert.deepEqual(registry.getAction('demo').promptPatterns, []);
  assert.ok(registry.getAction('demo').timeoutMs > 0);
});

test('groups actions that share a queue', () => {
  const registry = defineActions([
    { ...valid, queue: { name: 'shared', concurrency: 2 } },
    { ...valid, name: 'demo-2', queue: { name: 'shared', concurrency: 2 } }
  ]);
  assert.deepEqual(registry.queueGroups, [{ name: 'shared', concurrency: 2, actions: ['demo', 'demo-2'] }]);
});

test('rejects invalid definitions', () => {
  assert.throws(() => defineActions([{ ...valid, command: undefined }]), /command/);
  assert.throws(() => defineActions([valid, valid]), /trùng/);
  assert.throws(() => defineActions([{ ...valid, name: 'Bad Name' }]), /tên/);
  assert.throws(() => defineActions([{ ...valid, queue: { concurrency: 0 } }]), /concurrency/);
  assert.throws(() => defineActions([
    { ...valid, queue: { name: 'q', concurrency: 1 } },
    { ...valid, name: 'demo-2', queue: { name: 'q', concurrency: 3 } }
  ]), /không thống nhất/);
});
