# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run typecheck` — `tsc` (TypeScript 7), type-check only (`noEmit`); run it before considering a change done.
- `npm test` — all tests via the built-in `node --test` runner (no lint/build step).
- Single file: `node --test test/scheduler.test.ts`; single test: `node --test --test-name-pattern="cancels"`
- `npm run start` — the whole bot under **nodemon** (`nodemon.json`: watches `src/` and `.env`, runs `node src/index.ts`); dev only, a reload kills running commands. `npm run serve` — plain `node src/index.ts`, no reload. Only one instance may run (lock file next to the DB).
- `npm run register [-- -StartNow]` / `npm run unregister` — `scripts/register-task.ps1` / `unregister-task.ps1` (Windows PowerShell 5.1, files saved as UTF-8 **with BOM** so Vietnamese output works). Registers Task Scheduler task `\SlackBot\SlackCommandRunner` (own folder in the library, same convention as the user's `simple-cronjob` repo): at the current user's logon, plain node, no time limit. The action is `wscript.exe scripts\run-bot.vbs "<node.exe>"`; the VBS launcher hides the window (`shell.Run …, 0, True`), sets the repo root as cwd and appends output to `data/bot.log` via `cmd` redirection (keeps UTF-8). Unregister removes the task (also a legacy library-root one), deletes the `SlackBot` folder when empty, and kills the bot whose PID is in `data/slack-bot.lock` (only if it is a node running `src/index.ts`). Note: rewriting these `.ps1` files with a tool that preserves the BOM and then prepending one gives a double BOM, which breaks `param()` parsing.
- `npm i -g ./tools/gcmd-command` — installs the mock CLI globally **as `gcmd`** (shadows a real one).

Config is read from env/`.env` in `src/config.ts` (see `.env.example`).

## TypeScript setup

- ESM TypeScript run **directly by Node ≥ 24 via type stripping** — no build step, no `dist/`. `npm start` and tests execute `.ts` files; `tsc` only type-checks.
- Because of type stripping (`erasableSyntaxOnly`): no `enum`, `namespace` or constructor parameter properties; relative imports must include the `.ts` extension; type-only imports use `import type` (`verbatimModuleSyntax`).
- Shared types live in `src/types.ts` (`ActionDefinition`, `Action`, `JobResult`, `RunnerEvent`, `JobRecord`). `src/bot/slack.ts` is the minimal Slack client interface used by `jobs.ts`/`logStream.ts` so tests can pass fakes.
- `@types/node` is pinned to the 24.x line to match the runtime; bump both together.
- `tools/gcmd-command` stays plain CommonJS JavaScript: it is installed globally as a CLI and Node does not strip types inside `node_modules`.

## Architecture

**One Node process** on the Windows host (`src/index.ts`): Slack Bolt in Socket Mode (outbound only — no ports, no Docker), an in-process queue, and the command runner. There is no Redis/BullMQ; the project used them before and moved away to keep a single machine simple.

- `src/index.ts` — entry: acquires the single-instance lock (`src/shared/lock.ts`, `slack-bot.lock` next to the DB; a lock with a dead PID is taken over), opens SQLite, wires Slack listeners to the scheduler, runs startup recovery, starts Bolt.
- `src/worker/scheduler.ts` — `createScheduler({ groups, onStart, onEvent, onFinish })`: one FIFO per queue group, at most `concurrency` running (1 = sequential). `onStart` is **awaited before spawning**, so `#N Đang chạy lệnh` and the log message always precede output; `onFinish` is **awaited before the slot is freed**, so a job's `#N hoàn tất/thất bại` is posted before the next job on that queue is announced (a rejected `onFinish` is logged and never blocks the queue). While reporting, the slot still counts as busy for `mustWait`, but `sendInput`/`cancel` already treat the job as ended. API used by the bot: `enqueue`, `mustWait`, `removeQueued`, `sendInput`, `cancel`.
- `src/worker/runner.ts` — `runCommand` (see Runner below).
- `src/shared/db.ts` — SQLite job table (sql.js in memory, whole file rewritten on every write). Single source of truth for job status/history; never open it from another process.
- **Startup recovery** (`recoverJobs`): commands die with the process, so `running`/`waiting_input` jobs are marked failed (`Bị gián đoạn do bot khởi động lại.`); `queued` `job-N` jobs are re-enqueued in `created_at` order. Legacy UUID-id queued rows are cancelled silently, never run.

Key points:
- **Actions** are auto-loaded from every file in `src/actions/` except `index.ts`; `defineActions` validates shape and groups by queue (actions sharing a queue must agree on concurrency). Contract: `name, description, usage, parse(argsText), validate(input), command(input) → { file, args }`, optional `slashCommand, queue, timeoutMs, promptPatterns`. Help text, chat parsing and slash-command registration all derive from the registry — adding an action needs no other code change (but a new `slashCommand` must also be created in the Slack app). Input is validated when the job is created and again when the scheduler starts it.
- **Runner** (`runCommand`): spawns via `cross-spawn` (plain `spawn` with `shell:false` cannot run npm `.cmd` shims on Node ≥ 20.12). A *prompt* is a non-empty partial line that matches `promptPatterns` or is idle 500 ms; while open, the runtime timer is paused and `INPUT_TIMEOUT_MS` applies. New full lines while a prompt is open close it as a false positive. Kills use `taskkill /T /F` on Windows because the shim spawns a grandchild `node`. It never rejects: failures/timeouts/cancels resolve with `{ ok:false, exitCode, reason, cancelled }` and reach the bot via `onFinish`.
- **Queued vs running message**: `enqueueJob` asks `scheduler.mustWait` (jobs waiting, or all slots busy). If the job must wait it posts `Đã thêm #N \`cmd\` vào hàng đợi` and stores `announced = 0`; `onStart` then posts `#N Đang chạy lệnh \`cmd\`` and sets `announced = 1`. Otherwise the running message is posted immediately. The `announced` column comes from a small migration in `createDatabase` (default 1 for old rows).
- **Built-in bot commands** `queue` and `cancel #N` (`isQueueCommand`/`parseCancel` in `src/bot/commands.ts`; both are reserved action names). Every route calls `tryBuiltinCommand` *before* forwarding input, so they work while a job waits for an answer. `queue` renders `scheduler.snapshot()` (in-memory running/waiting jobs per queue, in order) with status/user from the DB via `formatQueueStatus` (`src/bot/queueStatus.ts`).
- **`cancel #N`**: Queued → `scheduler.removeQueued` + DB `cancelled`; running/waiting → `scheduler.cancel` → `run.kill()` → result `{ cancelled: true, cancelledBy }` → `#N đã bị huỷ bởi …`. Finished → `#N đã hoàn thành.`, unknown → `Không tìm thấy #N.`
- **DMs are flat** (no threads): `isDirectMessage` (`D…` channel id) makes `enqueueJob` post top-level and store `slack_thread_ts = ''`, which `toJob` turns into `threadTs: undefined` so every later post/log update is top-level too. In a DM, any message while `findWaitingJobInChannel` finds a `waiting_input` job is that job's answer; otherwise it's a command/help.
- **Thread routing in channels** (`src/index.ts`): a message in a thread that `findActiveJobByThread` maps to a queued/running/waiting job is an answer → `forwardInput` → `scheduler.sendInput`; otherwise @mentions go to `runChatCommand` (unknown text → help). Plain thread replies are handled by the `message` listener and replies that @mention the bot only by `app_mention`, so nothing is processed twice.
- **Live log** (`src/bot/logStream.ts`): one message per job edited via `chat.update` at most every 2 s, calls serialized per job; output arriving after `finish` is dropped.
- **Job ids** are `job-N`, shown in Slack as `#N` (`toJobId`/`jobLabel` in `src/bot/jobs.ts`). N is an in-memory counter seeded from `maxJobNumber(db)` — safe only because a single instance runs.
- **Slack messages are deliberately terse**: prompts are posted as `❓ [#N] <prompt text>` (`promptMessage`), answers are not acknowledged (they're appended to the live log via the `input-received` event), and completion is just `#N hoàn tất` / `#N thất bại …`.
- Args are always arrays, never shell strings; `src/shared/validators.ts` `ticketPattern` is the injection guard (tested).
- Empty `AUTHORIZED_CHANNEL_IDS` / `AUTHORIZED_USER_IDS` means allow everyone; the same check gates answering prompts and cancelling.
- User-facing Slack text is Vietnamese.

## Tests

`test/scheduler.test.ts` covers ordering/concurrency/cancel/input with fast `node -e` actions. `test/runner.test.ts` drives the real mock (`tools/gcmd-command/bin/gcmd.js` via `process.execPath`, `--delay 0`) for streaming, prompt answers and timeouts — its deploy cases are sensitive to delays added to the mock. Other tests are pure units (registry, chat parsing, sql.js DB in a temp dir, lock file, log stream with a fake Slack client).
