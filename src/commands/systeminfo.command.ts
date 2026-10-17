import type { CommandDefinition } from '../types.ts';

export default {
  name: 'systeminfo',
  description: "Show the bot host's system information (`systeminfo`).",
  usage: 'systeminfo',
  // Heavy WMI queries that take a few seconds: one at a time.
  queue: { name: 'systeminfo', concurrency: 1 },
  timeoutMs: 2 * 60 * 1000,
  // Takes no arguments, so nothing typed in chat ever reaches the command line.
  parse: (argsText) => ({ args: argsText.trim() }),
  validate: (input) => {
    if (input.args) throw new Error('`systeminfo` takes no arguments.');
    return {};
  },
  build: () => ({ file: 'systeminfo', args: [] })
} satisfies CommandDefinition;
