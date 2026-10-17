import { validateTicket } from '../shared/validators.ts';
import type { CommandDefinition } from '../types.ts';

export default {
  name: 'status',
  description: 'Chạy `gcmd status --ticket <TICKET>` (song song).',
  usage: 'status GCD-123',
  queue: { name: 'status', concurrency: 4 },
  timeoutMs: 5 * 60 * 1000,
  parse: (argsText) => ({ ticket: argsText.trim() }),
  validate: (input) => ({ ticket: validateTicket(input.ticket) }),
  build: (input) => ({ file: 'gcmd', args: ['status', '--ticket', input.ticket] })
} satisfies CommandDefinition;
