const { spawn } = require('node:child_process');

const ticketPattern = /^[A-Z][A-Z0-9]*-[0-9]+$/;

function validateTicket(ticket) {
  if (typeof ticket !== 'string' || !ticketPattern.test(ticket)) {
    throw new Error('Ticket phải có định dạng như GCD-123.');
  }
  return ticket;
}

function deploy({ ticket, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn('gcmd', ['deploy', '--ticket', ticket], {
      shell: false,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, exitCode: null, stdout, stderr: 'Command timeout.' });
    }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => finish({ ok: false, exitCode: null, stdout, stderr: error.message }));
    child.on('close', (exitCode) => finish({ ok: exitCode === 0, exitCode, stdout, stderr }));
  });
}

const actions = {
  deploy: {
    validate: (input) => ({ ticket: validateTicket(input.ticket) }),
    execute: deploy
  }
};

module.exports = { actions, ticketPattern, validateTicket };
