# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run typecheck` — `tsc` (TypeScript 7), type-check only (`noEmit`); run it before considering a change done.
- `npm test` — all tests via the built-in `node --test` runner (no lint/build step).
- Single file: `node --test test/runner.test.ts`; single test: `node --test --test-name-pattern="cancels"`
- `docker compose up -d --build` — Redis (published on `127.0.0.1:6379`) + bot container.
- `npm run start:worker` — worker on the Windows host that has `gcmd` (not in Docker).
- `npm i -g ./tools/gcmd-command` — installs the mock CLI globally **as `gcmd`** (shadows a real one).

Config is read from env/`.env` in `src/config.ts` (see `.env.example`). `.env` uses `REDIS_HOST=127.0.0.1` for the host worker; `docker-compose.yml` overrides it to `redis` for the bot.

## TypeScript setup

- ESM TypeScript run **directly by Node ≥ 24 via type stripping** — no build step, no `dist/`. `npm run start:*`, the Dockerfile (`node:24`) and tests all execute `.ts` files. `tsc` only type-checks.
- Because of type stripping (`erasableSyntaxOnly`): no `enum`, `namespace` or constructor parameter properties; relative imports must include the `.ts` extension; type-only imports use `import type` (`verbatimModuleSyntax`).
- Shared types live in `src/types.ts` (`ActionDefinition`, `Action`, `JobData`, `JobResult`, `RunnerEvent`/`BusEvent`, `JobRecord`). `src/bot/slack.ts` is the minimal Slack client interface used by `jobs.ts`/`logStream.ts` so tests can pass fakes.
- `@types/node` is pinned to the 24.x line to match the runtime; bump both together.
- `tools/gcmd-command` stays plain CommonJS JavaScript: it is installed globally as a CLI and Node does not strip types inside `node_modules`.

## Architecture

Two processes that only talk through Redis:

- **Bot** (`src/bot/index.ts`, Docker, Slack Bolt Socket Mode) — parses slash commands, DMs and @mentions, enqueues jobs, renders progress into the job's Slack thread, and forwards thread replies to the running command. Owns the SQLite job table (`src/shared/db.ts`, sql.js in memory, whole file rewritten on every write — never open it from another process).
- **Worker** (`src/worker/index.ts`, Windows host) — one BullMQ `Worker` per queue group; runs commands through `src/worker/runner.ts`.

Two Redis channels between them:
1. **BullMQ queues** (`src/shared/queue.ts`), one per `action.queue.name`, named `${QUEUE_PREFIX}-<name>`. The worker calls `setGlobalConcurrency(concurrency)` so `concurrency: 1` is sequential across *all* worker processes. `maxStalledCount: 0` so a crashed worker never silently re-runs a deploy. Durable; carries the final result.
2. **Pub/sub bus** (`src/shared/bus.ts`), fire-and-forget: worker → bot `${prefix}:events` (`output`, `prompt`, `prompt-closed`, `input-received`); bot → worker `${prefix}:input:<jobId>` (answers). `sendInput` returns the receiver count (0 = no worker running that job).

Key points:
- **Actions** are auto-loaded from every file in `src/actions/` except `index.ts`; `defineActions` validates shape and groups by queue (actions sharing a queue must agree on concurrency). Contract: `name, description, usage, parse(argsText), validate(input), command(input) → { file, args }`, optional `slashCommand, queue, timeoutMs, promptPatterns`. Help text, chat parsing and slash-command registration all derive from the registry — adding an action needs no other code change (but a new `slashCommand` must also be created in the Slack app). Validation runs in both bot and worker.
- **Runner** (`runCommand`): spawns via `cross-spawn` (plain `spawn` with `shell:false` cannot run npm `.cmd` shims on Node ≥ 20.12). A *prompt* is a non-empty partial line that matches `promptPatterns` or is idle 500 ms; while open, the runtime timer is paused and `INPUT_TIMEOUT_MS` applies. New full lines while a prompt is open close it as a false positive. Kills use `taskkill /T /F` on Windows because the shim spawns a grandchild `node`. `execute` never rejects: command failures/timeouts resolve with `{ ok:false, exitCode, reason }`, so they arrive in the bot's `completed` handler; `failed` only fires when the processor throws.
- **Queued vs running message**: `enqueueJob` calls `mustWait` (BullMQ `getJobCounts`: anything waiting, or `active >= concurrency`). If the job must wait it posts `Đã thêm #N \`cmd\` vào hàng đợi` and stores `announced = 0`; `onActive` then posts `#N Đang chạy lệnh \`cmd\`` and sets `announced = 1`. Otherwise the running message is posted immediately. The `announced` column is added by a small migration in `createDatabase` (default 1 for old rows).
- **`cancel #N`** is a built-in bot command (`parseCancel` in `src/bot/commands.ts`; `cancel` is a reserved action name). Every route calls `tryCancel` *before* forwarding input, so it works while a job waits for an answer. Queued jobs are removed from BullMQ (`removeQueuedJob`); running/waiting ones get `bus.sendCancel` on the job's input channel → worker `run.kill()` → result `{ cancelled: true, cancelledBy }` → DB status `cancelled` and `#N đã bị huỷ bởi …`. Finished → `#N đã hoàn thành.`, unknown → `Không tìm thấy #N.`
- **DMs are flat** (no threads): `isDirectMessage` (`D…` channel id) makes `enqueueJob` post top-level and store `slack_thread_ts = ''`, which `toJob` turns into `threadTs: undefined` so every later post/log update is top-level too. In a DM, any message while `findWaitingJobInChannel` finds a `waiting_input` job is that job's answer; otherwise it's a command/help.
- **Thread routing in channels** (`src/bot/index.ts`): a message in a thread that `findActiveJobByThread` maps to a queued/running/waiting job is an answer → `forwardInput`; otherwise DMs and @mentions go to `runChatCommand` (unknown text → help). In channels, plain thread replies are handled by the `message` listener and replies that @mention the bot only by `app_mention`, so nothing is processed twice.
- **Live log** (`src/bot/logStream.ts`): one message per job edited via `chat.update` at most every 2 s, calls serialized per job; output arriving after `finish` is dropped.
- **Job ids** are `job-N` (BullMQ rejects purely numeric custom ids) and shown in Slack as `#N` (`toJobId`/`jobLabel` in `src/bot/jobs.ts`). N comes from Redis `INCR ${prefix}:job-seq`; on startup the bot bumps the counter to at least `maxJobNumber(db)` so a wiped Redis can't reuse ids.
- **Slack messages are deliberately terse**: prompts are posted as `❓ <prompt text>`, answers are not acknowledged (they're appended to the live log via the `input-received` event), and completion is just `#N hoàn tất` / `#N thất bại …`.
- Args are always arrays, never shell strings; `src/shared/validators.ts` `ticketPattern` is the injection guard (tested).
- Empty `AUTHORIZED_CHANNEL_IDS` / `AUTHORIZED_USER_IDS` means allow everyone; the same check gates answering prompts.
- User-facing Slack text is Vietnamese.

## Tests

`test/runner.test.ts` drives the real mock (`tools/gcmd-command/bin/gcmd.js` via `process.execPath`, `--delay 0`) to cover streaming, prompt answers, input/runtime timeouts. Other tests are pure units (registry, chat parsing, sql.js DB in a temp dir, log stream with a fake Slack client).
