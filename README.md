# Slack Command Runner

**English** | [Tiếng Việt](README.vi.md)

A Slack bot that takes commands from users (for example `deploy GCD-123`), queues them and runs them directly on the Windows machine that has `gcmd` — all in **a single Node.js process**. While a command runs:

- its output is streamed into Slack (one log message that keeps updating);
- when the command asks something (for example `Are you sure? [Y/n]`), the bot posts `❓ [#N] <question>`; the user replies and the answer goes straight to the command;
- when it ends the bot posts `#N completed` or `#N failed …`.

Available commands:

| Command | Runs | Mode |
|---|---|---|
| `deploy GCD-123` | `gcmd deploy --ticket GCD-123` | Sequential (one job at a time), asks for confirmation |
| `status GCD-123` | `gcmd status --ticket GCD-123` | Parallel (up to 4 jobs) |
| `ipconfig` / `ipconfig /all` | `ipconfig` / `ipconfig /all` on the bot's machine | Parallel (up to 4 jobs); only these two forms are accepted |
| `systeminfo` | `systeminfo` on the bot's machine | Sequential; takes no arguments; takes a few seconds |

## Architecture

```
Slack ◀──Socket Mode──▶ Node.js on the Windows machine ──▶ gcmd
                        ├─ bot (src/bot/): receives messages, shows logs, questions, results
                        ├─ queue (src/worker/scheduler.ts): sequential / parallel per command
                        └─ SQLite (data/slack-bot.sqlite): job history, #N numbering
```

- Socket Mode only needs an **outbound** connection to Slack — no open ports or public URL.
- No Docker, Redis or separate queue service is needed.
- **Only one instance may run.** A second one exits with `The bot is already running in another process (PID …)` (lock file `data/slack-bot.lock`).
- On restart: jobs that were running are reported as `#N failed: Interrupted because the bot restarted.`; jobs still in the queue resume in order.

---

## 1. Register the Slack app and bot

### Quick way: create it from a manifest

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**.
2. Pick the workspace, choose **YAML** and paste the following (you can change `name`/`display_name`):

```yaml
display_information:
  name: Command Runner
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Command Runner
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - groups:history
      - im:history
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

3. Click **Create**, then continue with [Get the tokens](#get-the-tokens).

### Manual way (without a manifest)

1. <https://api.slack.com/apps> → **Create New App** → **From scratch** → name it, pick the workspace.
2. **Socket Mode** → turn on **Enable Socket Mode**.
3. **OAuth & Permissions** → **Bot Token Scopes** → add:
   `app_mentions:read`, `channels:history`, `chat:write`, `groups:history`, `im:history`, `users:read`.
4. **Event Subscriptions** → turn on **Enable Events** → **Subscribe to bot events** → add:
   `app_mention`, `message.channels`, `message.groups`, `message.im` → **Save Changes**.
5. **App Home** → **Show Tabs** → turn on **Messages Tab** and tick **Allow users to send Slash commands and messages from the messages tab**.

### Get the tokens

The bot needs **both** tokens:

| Variable | Where to get it | Used for |
|---|---|---|
| `SLACK_APP_TOKEN` (`xapp-…`) | **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** → add scope `connections:write` → **Generate** | Opening the Socket Mode connection, receiving events |
| `SLACK_BOT_TOKEN` (`xoxb-…`) | **OAuth & Permissions** → **Install to Workspace** → **Allow** → copy the **Bot User OAuth Token** | Posting and updating messages |

> Whenever you change scopes or events, Slack asks you to **Reinstall to Workspace** — the change only takes effect after reinstalling.

### Add the bot to a channel

In each channel where you want to use the bot, type `/invite @Command Runner` (or your bot's name). Direct messages (DMs) with the bot don't need this.

### (Optional) Restrict who can use the bot

- **Channel ID**: open the channel → click its name → the bottom of the **About** tab shows `Channel ID` (like `C0123…`).
- **User ID**: open the profile → **⋮** → **Copy member ID** (like `U0123…`).

Put them in `AUTHORIZED_CHANNEL_IDS` / `AUTHORIZED_USER_IDS` (comma-separated). Empty means **everyone is allowed**. The same lists apply to running commands, answering their questions and viewing the queue.

**Cancelling is stricter** (see [Cancelling a job](#cancelling-a-job)): with `AUTHORIZED_USER_IDS` set, **only the listed users** can cancel jobs — and any of them can cancel a job started by someone else. Setting it also means only those users can run commands at all. With it empty, only a job's own creator can cancel it.

---

## 2. Install and run

Requirements: Node.js ≥ 24 on the Windows machine that has `gcmd`. The project is written in TypeScript and run directly by Node (no build step).

### Configuration

```powershell
copy .env.example .env
```

Open `.env` and fill in:

| Variable | Meaning | Default |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Tokens from the step above | — |
| `DATABASE_PATH` | SQLite file holding the job history; the lock file lives in the same folder | `./data/slack-bot.sqlite` |
| `COMMAND_TIMEOUT_MS` | Maximum run time of a command (time waiting for an answer is not counted) | 30 minutes |
| `INPUT_TIMEOUT_MS` | How long to wait for a user's answer before the command is cancelled | 30 minutes |
| `AUTHORIZED_CHANNEL_IDS`, `AUTHORIZED_USER_IDS` | Restrict channels / users | empty = everyone |

### Run the bot

```powershell
npm ci
npm run start   # dev: nodemon, reloads when files in src/ or .env change
npm run serve   # run once, no reload
```

You should see `⚡ Slack bot is running in Socket Mode (commands: …)`. `gcmd` must be on the `PATH` of the account running the bot. Stop it with `Ctrl+C`.

> Every nodemon reload kills the commands that are running (for example a deploy waiting at `[Y/n]`) and reports `#N failed: Interrupted because the bot restarted.` Only use `npm run start` for development.

### Start automatically at Windows sign-in (Task Scheduler)

```powershell
npm run register                # create the task: start the bot every time you sign in to Windows
npm run register -- -StartNow   # create the task and start it right away
npm run unregister              # remove the task (and its folder), stop the bot the task started
```

- The task lives in its own folder: **Task Scheduler Library › SlackBot › SlackCommandRunner** (open Task Scheduler from Windows Search). `unregister` also deletes the folder once it is empty.
- The task runs `node src/index.ts` (not nodemon) under your Windows account, without admin rights, through the hidden launcher `scripts/run-bot.vbs` (`wscript.exe`), so no console window appears.
- Output is appended to `data/bot.log`.
- No run-time limit; if the task fails it is restarted after 1 minute. Run `npm run register` again to update the task (for example after moving the project or changing the Node version).
- `unregister` only stops a bot started by the task; a bot started with `npm run start`/`serve` is left running.
- **Only one instance may run**: while the task is running, don't also run `npm run start`/`serve` (and vice versa) — the second one exits with `The bot is already running in another process (PID …)`.

---

## 3. Using it in Slack

### Sending a command

Two ways, same result:

- **Direct message** to the bot: `deploy GCD-123`
- **@mention** in a channel: `@Command Runner deploy GCD-123`

Tickets must look like `LETTERS-NUMBER` (for example `GCD-123`). For anything the bot doesn't understand, it replies with `Supported commands:` and the list of commands.

### Following a job and answering

**Direct message (DM):** the bot replies straight into the conversation, without threads. When it posts `❓ [#N] …`, just send your answer as a normal message:

```
#1 Running `gcmd deploy --ticket GCD-123`
📜 Log #1 (running…)
❓ [#1] Are you sure you want to deploy GCD-123 to production? [Y/n]
Y                                                 ← you
❓ [#1] Release note (optional):
fix login                                         ← you
#1 completed
```

> In a DM, while a job is waiting for an answer, your next message is **always taken as the answer** (even if you type `deploy …`). Answer first, then send the new command.

**In a channel:** every update of a job goes to the thread of its `#N Running …` message (or the thread where you @mentioned the bot):

```
#1 Running `gcmd deploy --ticket GCD-123`
  └ 📜 Log #1 (running…)                          ← updates about every 2 seconds
  └ ❓ [#1] Are you sure you want to deploy GCD-123 to production? [Y/n]
  └ (you reply: Y)                                ← the bot doesn't reply; the answer shows up in the log
  └ ❓ [#1] Release note (optional):
  └ (you reply: fix login)
  └ @you #1 completed                             ← in channels the creator is @mentioned when the job ends
```

- In a channel, answer by **replying in the job's thread**. The answer is sent to the command followed by Enter; an empty reply (just @mentioning the bot) is the same as pressing Enter.
- Anyone allowed to use the bot can answer.
- If nobody answers within `INPUT_TIMEOUT_MS` (30 minutes by default), the command is cancelled: `#1 failed: No answer received in time (30 minutes).`
- `deploy` jobs run one after another — the next job waits until the previous one has finished (and reported `completed`/`failed`). `status` jobs run in parallel.
- If a job has to wait (jobs are already waiting, or every slot is busy), the bot first posts ``Added #4 `gcmd deploy --ticket GCD-111` to the queue``, then `#4 Running …` when the job actually starts. A job that can start right away only gets `#4 Running …`.

### Viewing the queue

Type `queue` (in a DM, when @mentioning the bot, or as a reply in the thread of a running job) to see the running and waiting jobs per command:

```
📋 Queue
*deploy* (sequential)
• #15 `gcmd deploy --ticket GCD-1` — ❓ waiting for an answer · Gia
• #16 `gcmd deploy --ticket GCD-2` — ⏳ queued (position 1) · Gia
*status* (up to 4 in parallel)
• #18 `gcmd status --ticket GCD-9` — ▶️ running · Gia
```

It lists **all** jobs, including ones started in other people's DMs. Creators are shown by plain name, never as an @mention, so listing the queue notifies nobody (names are looked up with the `users:read` scope; without it, or if a lookup fails, the user ID is shown instead). Commands without jobs are left out; if everything is empty the bot replies `📋 The queue is empty…`. Like `cancel`, `queue` is always treated as a bot command, even while a DM job is waiting for an answer.

### Cancelling a job

Type `cancel #3` (or `cancel 3`) — in a DM, when @mentioning the bot, or as a reply in the job's thread:

| Job state | What the bot does |
|---|---|
| Queued | Removes it from the queue and posts `#3 cancelled by @you` |
| Running / waiting for an answer | Kills the command (including child processes) and posts `#3 cancelled by @you` |
| Finished (completed, failed or cancelled) | Replies `#3 has already finished.` |
| No job with that number | Replies `#3 not found.` |

- `cancel` is always treated as a cancel command, even while a DM job is waiting for an answer.
- The cancel message is posted where the job lives (the DM or the job's thread). If you type `cancel` somewhere else, the bot also replies `Cancelling #3…` there.
- **Who can cancel:** with `AUTHORIZED_USER_IDS` set, only the listed users — and they can cancel any job, so A can cancel a job started by B. With `AUTHORIZED_USER_IDS` empty, only the user who started the job.
- In a channel, when someone else cancels your job the bot @mentions you.

### Troubleshooting

| Symptom | Common cause |
|---|---|
| The bot doesn't respond at all | The bot isn't running (`npm run start` / `npm run register`, check `data/bot.log`), a scope/event is missing, or the app wasn't **reinstalled** after changing scopes; in a channel, the bot hasn't been `/invite`d |
| Replies in a thread are ignored | Missing event `message.channels` / `message.groups` or scope `channels:history` / `groups:history` |
| `The bot is already running in another process (PID …)` on start | Another instance is running (for example from Task Scheduler). Stop it first (`npm run unregister` or `Ctrl+C`) |
| `#N failed: Interrupted because the bot restarted.` | The bot was stopped/restarted while the job was running; run the command again if needed |
| `#N failed: spawn gcmd ENOENT` | `gcmd` is not on the `PATH` of the account running the bot |

---

## 4. Adding a command

Each command is one file named `<name>.command.ts` in `src/commands/`. The bot loads every `*.command.ts` file automatically; the help text and chat syntax update themselves:

```ts
// src/commands/restart.command.ts
import { validateTicket } from '../shared/validators.ts';
import type { CommandDefinition } from '../types.ts';

export default {
  name: 'restart',                                   // the word users type in chat
  description: 'Restart the service of a ticket.',   // shown in the help text
  usage: 'restart GCD-123',
  queue: { name: 'restart', concurrency: 1 },        // 1 = sequential, N = up to N jobs in parallel
  timeoutMs: 10 * 60 * 1000,                         // maximum run time, not counting time waiting for answers
  promptPatterns: [/\[y\/n\]\s*$/i],                 // optional; an unfinished line that stays idle for 0.5 s also counts as a question
  parse: (argsText) => ({ ticket: argsText.trim() }),
  validate: (input) => ({ ticket: validateTicket(input.ticket) }),
  build: (input) => ({ file: 'gcmd', args: ['restart', '--ticket', input.ticket] })  // the process to run
} satisfies CommandDefinition;
```

Notes:

- Relative imports must include the `.ts` extension; run `npm run typecheck` to check types.
- Always pass arguments as the `args` array and validate every user-provided value in `validate` — **never build a shell command string**.
- Write `description` and error messages in English, like the built-in commands.
- Restart the bot after adding a command.

---

## 5. Testing

### Mock `gcmd`

`tools/gcmd-command` is a mock of the `gcmd` CLI (deploy asks `[Y/n]` and for a release note; status asks nothing). It installs globally as **`gcmd`**, so it **shadows a real `gcmd`** on the machine:

```powershell
npm i -g ./tools/gcmd-command     # install
gcmd deploy --ticket GCD-123      # try it by hand
npm rm -g gcmd-command            # remove it when using the real gcmd
```

Details: `tools/gcmd-command/README.md`.

### Unit tests

```powershell
npm run typecheck                               # type-check (tsc, no build)
npm test                                        # everything
node --test test/runner.test.ts                 # one file
node --test --test-name-pattern="cancels"       # one test by name
```
