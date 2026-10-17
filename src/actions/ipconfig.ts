import type { ActionDefinition } from '../types.ts';

// Allowlisted arguments only: chat text never reaches the command line as-is.
const modes: Record<string, string[]> = {
  '': [],
  all: ['/all'],
  '/all': ['/all']
};

export default {
  name: 'ipconfig',
  description: 'Xem cấu hình mạng của máy chạy bot (`ipconfig`, hoặc `ipconfig /all` để xem chi tiết).',
  usage: 'ipconfig',
  queue: { name: 'ipconfig', concurrency: 4 },
  timeoutMs: 60 * 1000,
  parse: (argsText) => ({ mode: argsText.trim().toLowerCase() }),
  validate: (input) => {
    const mode = input.mode ?? '';
    if (!(mode in modes)) throw new Error('Chỉ hỗ trợ `ipconfig` hoặc `ipconfig /all`.');
    return { mode: modes[mode].length ? '/all' : '' };
  },
  command: (input) => ({ file: 'ipconfig', args: modes[input.mode ?? ''] ?? [] })
} satisfies ActionDefinition;
