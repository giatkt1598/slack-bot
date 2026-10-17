import { config } from '../config.ts';
import { validateTicket } from '../shared/validators.ts';
import type { ActionDefinition } from '../types.ts';

export default {
  name: 'deploy',
  description: 'Chạy `gcmd deploy --ticket <TICKET>` (tuần tự, có hỏi xác nhận).',
  usage: 'deploy GCD-123',
  slashCommand: '/deploy',
  queue: { name: 'deploy', concurrency: 1 },
  timeoutMs: config.commandTimeoutMs,
  promptPatterns: [/\[y\/n\]\s*$/i],
  parse: (argsText) => ({ ticket: argsText.trim() }),
  validate: (input) => ({ ticket: validateTicket(input.ticket) }),
  command: (input) => ({ file: 'gcmd', args: ['deploy', '--ticket', input.ticket] })
} satisfies ActionDefinition;
