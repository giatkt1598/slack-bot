import test from 'node:test';
import assert from 'node:assert/strict';
import { commands, getCommand, queueGroups, defineCommands } from '../src/commands/index.ts';
import type { CommandDefinition } from '../src/types.ts';

const valid: CommandDefinition = {
  name: 'demo',
  description: 'Demo',
  usage: 'demo X',
  parse: (args) => ({ value: args }),
  validate: (input) => input,
  build: (input) => ({ file: 'echo', args: [input.value] })
};

// Definitions come from files at runtime, so the registry must also reject shapes the types forbid.
const untyped = (definition: object) => definition as CommandDefinition;

test('loads the bundled commands with sequential deploy and parallel status/ipconfig queues', () => {
  assert.deepEqual(commands.map((command) => command.name).sort(), ['deploy', 'ipconfig', 'status', 'systeminfo']);
  assert.equal(getCommand('deploy')?.queue.concurrency, 1);
  assert.ok((getCommand('status')?.queue.concurrency ?? 0) > 1);
  assert.ok((getCommand('ipconfig')?.queue.concurrency ?? 0) > 1);
  assert.deepEqual(queueGroups.map((group) => group.name).sort(), ['deploy', 'ipconfig', 'status', 'systeminfo']);
});

test('ticket commands build argument arrays without a shell', () => {
  for (const command of commands.filter((candidate) => candidate.name === 'deploy' || candidate.name === 'status')) {
    const input = command.validate(command.parse('GCD-123'));
    const { file, args } = command.build(input);
    assert.equal(typeof file, 'string');
    assert.ok(Array.isArray(args));
    assert.ok(args.includes('GCD-123'));
    assert.throws(() => command.validate(command.parse('GCD-1; whoami')));
  }
});

test('systeminfo takes no arguments and runs plain systeminfo', () => {
  const systeminfo = getCommand('systeminfo')!;
  const run = (text: string) => systeminfo.build(systeminfo.validate(systeminfo.parse(text)));
  assert.deepEqual(run(''), { file: 'systeminfo', args: [] });
  assert.deepEqual(run('   '), { file: 'systeminfo', args: [] });
  for (const text of ['/fo csv', '& whoami', 'now']) {
    assert.throws(() => systeminfo.validate(systeminfo.parse(text)), /takes no arguments/);
  }
  assert.equal(systeminfo.queue.concurrency, 1);
});

test('ipconfig accepts only "" and "/all" and passes nothing else to the command', () => {
  const ipconfig = getCommand('ipconfig')!;
  const run = (text: string) => ipconfig.build(ipconfig.validate(ipconfig.parse(text)));
  assert.deepEqual(run(''), { file: 'ipconfig', args: [] });
  assert.deepEqual(run('/all'), { file: 'ipconfig', args: ['/all'] });
  assert.deepEqual(run(' ALL '), { file: 'ipconfig', args: ['/all'] });
  for (const text of ['/release', '/all & whoami', '; whoami', '/flushdns']) {
    assert.throws(() => ipconfig.validate(ipconfig.parse(text)), /Only `ipconfig`/);
  }
});

test('applies defaults: own queue, concurrency 1, no prompt patterns', () => {
  const demo = defineCommands([valid]).getCommand('demo');
  assert.deepEqual(demo?.queue, { name: 'demo', concurrency: 1 });
  assert.deepEqual(demo?.promptPatterns, []);
  assert.ok((demo?.timeoutMs ?? 0) > 0);
});

test('groups commands that share a queue', () => {
  const registry = defineCommands([
    { ...valid, queue: { name: 'shared', concurrency: 2 } },
    { ...valid, name: 'demo-2', queue: { name: 'shared', concurrency: 2 } }
  ]);
  assert.deepEqual(registry.queueGroups, [{ name: 'shared', concurrency: 2, commands: ['demo', 'demo-2'] }]);
});

test('rejects invalid definitions', () => {
  assert.throws(() => defineCommands([untyped({ ...valid, build: undefined })]), /"build"/);
  assert.throws(() => defineCommands([valid, valid]), /more than once/);
  assert.throws(() => defineCommands([{ ...valid, name: 'Bad Name' }]), /name may only/);
  assert.throws(() => defineCommands([{ ...valid, name: 'cancel' }]), /reserved/);
  assert.throws(() => defineCommands([{ ...valid, name: 'queue' }]), /reserved/);
  assert.throws(() => defineCommands([{ ...valid, queue: { concurrency: 0 } }]), /concurrency/);
  assert.throws(() => defineCommands([
    { ...valid, queue: { name: 'q', concurrency: 1 } },
    { ...valid, name: 'demo-2', queue: { name: 'q', concurrency: 3 } }
  ]), /conflicting concurrency/);
});
