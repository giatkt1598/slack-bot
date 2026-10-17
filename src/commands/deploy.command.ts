import { config } from '../config.ts';
import { validateTicket } from '../shared/validators.ts';
import type { CommandDefinition } from '../types.ts';

export default {
  name: 'deploy',
  description: 'Run `gcmd deploy --ticket <TICKET>` (sequential, asks for confirmation).',
  usage: 'deploy GCD-123',
  slashCommand: '/deploy',
  queue: { name: 'deploy', concurrency: 1 },
  timeoutMs: config.commandTimeoutMs,
  promptPatterns: [/\[y\/n\]\s*$/i],
  parse: (argsText) => ({ ticket: argsText.trim() }),
  validate: (input) => ({ ticket: validateTicket(input.ticket) }),
  build: (input) => ({ file: 'gcmd', args: ['deploy', '--ticket', input.ticket] })
} satisfies CommandDefinition;
