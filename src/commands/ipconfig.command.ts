import type { CommandDefinition } from '../types.ts';

// Allowlisted arguments only: chat text never reaches the command line as-is.
const modes: Record<string, string[]> = {
  '': [],
  all: ['/all'],
  '/all': ['/all']
};

export default {
  name: 'ipconfig',
  description: "Show the bot host's network configuration (`ipconfig`, or `ipconfig /all` for details).",
  usage: 'ipconfig',
  queue: { name: 'ipconfig', concurrency: 4 },
  timeoutMs: 60 * 1000,
  parse: (argsText) => ({ mode: argsText.trim().toLowerCase() }),
  validate: (input) => {
    const mode = input.mode ?? '';
    if (!(mode in modes)) throw new Error('Only `ipconfig` and `ipconfig /all` are supported.');
    return { mode: modes[mode].length ? '/all' : '' };
  },
  build: (input) => ({ file: 'ipconfig', args: modes[input.mode ?? ''] ?? [] })
} satisfies CommandDefinition;
