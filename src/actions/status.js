const { config } = require('../config');
const { validateTicket } = require('../shared/validators');

module.exports = {
  name: 'status',
  description: 'Chạy `gcmd status --ticket <TICKET>` (song song).',
  usage: 'status GCD-123',
  queue: { name: 'status', concurrency: 4 },
  timeoutMs: 5 * 60 * 1000,
  parse: (argsText) => ({ ticket: argsText.trim() }),
  validate: (input) => ({ ticket: validateTicket(input.ticket) }),
  command: (input) => ({ file: config.gcmdBin, args: ['status', '--ticket', input.ticket] })
};
