# Slack Command Runner

Slack Socket Mode bot that queues allowlisted actions in BullMQ/Redis. A Node.js worker on Windows runs them, streams their output back to the Slack thread live, and passes users' thread replies to the command's stdin when it asks a question (e.g. `Are you sure? [Y/n]`).

Built-in actions: `deploy GCD-123` (`gcmd deploy --ticket …`, sequential, interactive) and `status GCD-123` (`gcmd status --ticket …`, parallel).

## Local setup

1. Copy `.env.example` to `.env` and add `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.
2. Configure the Slack app:
   - Socket Mode on; slash command `/deploy`
   - Bot token scopes: `commands`, `chat:write`, `im:history`, `app_mentions:read`, `channels:history`, `groups:history`
   - Event Subscriptions → bot events: `message.im`, `app_mention`, `message.channels`, `message.groups`
   - App Home → enable the Messages Tab and "Allow users to send Slash commands and messages from the messages tab"
   - Reinstall the app to the workspace after changing scopes, and invite the bot to the channels it should work in.
3. Start Redis and the bot (Redis is published on `127.0.0.1:6379` only, for the host worker):

```powershell
docker compose up -d --build
```

4. On the Windows machine that has `gcmd`, start the worker (it reads the same `.env`; `REDIS_HOST=127.0.0.1`):

```powershell
npm ci
npm run start:worker
```

For a remote Docker host, point `REDIS_HOST` at a reachable address. Do not expose Redis publicly.

## Using it in Slack

- DM the bot or @mention it: `deploy GCD-123`, `@bot status GCD-123` (`/deploy GCD-123` also works).
- The job thread shows a live log message that is updated every ~2 s.
- When the command asks something, the bot posts `❓ Command đang hỏi: …`. Reply **in that thread** (any authorized user); the text is sent to the command followed by Enter. With no answer within `INPUT_TIMEOUT_MS` (30 min) the command is killed.
- Anything the bot does not understand gets a help message listing the available commands.

## Adding an action

Create one file in `src/actions/` — it is loaded automatically:

```js
// src/actions/restart.js
const { validateTicket } = require('../shared/validators');

module.exports = {
  name: 'restart',                                   // chat command word
  description: 'Restart service của ticket.',
  usage: 'restart GCD-123',
  slashCommand: '/restart',                          // optional; also create it in the Slack app
  queue: { name: 'restart', concurrency: 1 },        // 1 = sequential, N = up to N in parallel
  timeoutMs: 10 * 60 * 1000,                         // runtime limit, excluding time waiting for answers
  promptPatterns: [/\[y\/n\]\s*$/i],                 // optional; idle partial lines are detected anyway
  parse: (argsText) => ({ ticket: argsText.trim() }),
  validate: (input) => ({ ticket: validateTicket(input.ticket) }),
  command: (input) => ({ file: 'gcmd', args: ['restart', '--ticket', input.ticket] })
};
```

Keep executable arguments in the `args` array and validate every user value — never build a shell string. Restart both the bot and the worker after adding an action.

## Mock gcmd for testing

`tools/gcmd-command` is a mock `gcmd` CLI (deploy with `[Y/n]` + release-note prompts, status). It installs globally as `gcmd` and **shadows a real gcmd**:

```powershell
npm i -g ./tools/gcmd-command
gcmd deploy --ticket GCD-123
npm rm -g gcmd-command
```

See `tools/gcmd-command/README.md`.

## Windows Task Scheduler

Create a task that runs at startup and restarts on failure:

```text
Program: C:\Program Files\nodejs\node.exe
Arguments: D:\repos\slack-bot\src\worker\index.js
Start in: D:\repos\slack-bot
```

Run it as the account that can execute `gcmd`. Set the task's environment variables or place a `.env` beside the project.

## Tests

```powershell
npm test
```
