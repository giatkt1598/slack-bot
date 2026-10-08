# Slack Command Runner

Slack Socket Mode bot that queues allowlisted actions in BullMQ/Redis. A Node.js worker runs on Windows and executes registered actions, currently `gcmd deploy --ticket GCD-XXX`.

## Local setup

1. Copy `.env.example` to `.env` and add `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.
2. Configure a Slack app with Socket Mode, the `commands` scope, and the `/deploy` slash command.
3. Start Redis and the bot:

```powershell
docker compose up --build
```

4. On the Windows machine that has `gcmd`, install dependencies and start the worker:

```powershell
npm ci
npm run start:worker
```

The worker needs the same `REDIS_HOST`, `REDIS_PORT`, `QUEUE_NAME`, and command configuration. For Docker Desktop on the same machine, `REDIS_HOST=127.0.0.1` requires exposing Redis; for a remote Docker host, use its reachable hostname/IP. Do not expose Redis publicly.

## Windows Task Scheduler

Create a task that runs at startup and restarts on failure:

```text
Program: C:\Program Files\nodejs\node.exe
Arguments: D:\repos\slack-bot\src\worker.js
Start in: D:\repos\slack-bot
```

Run it as the account that can execute `gcmd`. Set the task's environment variables or place a `.env` beside the project.

## Adding an action

Add an entry to `src/actions.js` with `validate(input)` and `execute(input)`, then add a Slack command handler and enqueue the action name in `src/bot.js`. Keep executable arguments separate from user input and never use shell interpolation.

## Tests

```powershell
npm test
```
