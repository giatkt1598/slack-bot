#!/usr/bin/env node
// Mock of the real `gcmd` CLI for testing the Slack command runner end to end.
const readline = require('node:readline');

const usage = `Usage:
  gcmd deploy --ticket <TICKET> [--delay <ms>] [--fail]
  gcmd status --ticket <TICKET> [--delay <ms>]`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, delay: 400, fail: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--ticket') options.ticket = rest[++i];
    else if (rest[i] === '--delay') options.delay = Number(rest[++i]);
    else if (rest[i] === '--fail') options.fail = true;
    else if (rest[i] === '--help' || rest[i] === '-h') options.command = '--help';
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reads answers line by line; works when stdin is a pipe (no TTY). Resolves null on EOF.
function createAsker() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  return {
    ask(question) {
      process.stdout.write(question);
      if (lines.length) return Promise.resolve(lines.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => rl.close()
  };
}

async function deploy({ ticket, delay, fail }) {
  const step = async (text, stream = process.stdout) => {
    await sleep(delay);
    stream.write(`${text}\n`);
  };
  await step(`[gcmd] Preparing deploy for ${ticket}`);
  await step('[gcmd] Fetching artifacts...');
  await step('[gcmd] warning: cache miss, downloading dependencies', process.stderr);
  await step('[gcmd] Build OK (3 artifacts)');

  const asker = createAsker();
  try {
    const answer = await asker.ask(`Are you sure you want to deploy ${ticket} to production? [Y/n] `);
    if (answer === null) {
      process.stderr.write('\n[gcmd] No input received, aborting.\n');
      return 1;
    }
    if (/^no?$/i.test(answer.trim())) {
      console.log(`[gcmd] Deploy ${ticket} cancelled by user`);
      return 1;
    }
    if (!/^(y(es)?)?$/i.test(answer.trim())) {
      console.error(`[gcmd] Invalid answer "${answer.trim()}", aborting.`);
      return 1;
    }
    const note = await asker.ask('Release note (optional): ');
    if (note === null) {
      process.stderr.write('\n[gcmd] No input received, aborting.\n');
      return 1;
    }
    if (note.trim()) console.log(`[gcmd] Release note: ${note.trim()}`);
  } finally {
    asker.close();
  }

  if (fail) {
    await step('[gcmd] error: rollout failed on node-2', process.stderr);
    return 2;
  }
  await step('[gcmd] Rolling out to production (1/2)');
  await step('[gcmd] Rolling out to production (2/2)');
  await step(`[gcmd] Deploy ${ticket} succeeded`);
  return 0;
}

async function status({ ticket, delay }) {
  await sleep(delay);
  console.log(`[gcmd] Status for ${ticket}`);
  await sleep(delay);
  console.log('[gcmd] production: v1.4.2 (healthy)');
  console.log('[gcmd] staging:    v1.5.0-rc1 (healthy)');
  return 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === '--help' || options.command === '-h') {
    console.log(usage);
    return 0;
  }
  if (!['deploy', 'status'].includes(options.command) || !options.ticket) {
    console.error(usage);
    return 64;
  }
  return options.command === 'deploy' ? deploy(options) : status(options);
}

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error(error);
  process.exitCode = 1;
});
