import test from "node:test";
import assert from "node:assert/strict";
import {
  enqueueJob,
  toJobId,
  jobLabel,
  formatCommand,
  isDirectMessage,
  promptMessage,
  mentionCreator,
} from "../src/bot/jobs.ts";
import type { EnqueueOptions } from "../src/bot/jobs.ts";
import type { SlackMessage } from "../src/bot/slack.ts";
import { getJob } from "../src/shared/db.ts";
import { bundledCommand, tempDatabase } from "./helpers.ts";

// A scheduler stand-in: `waits` is what mustWait answers; enqueued job ids are recorded.
function fakeScheduler(waits = false) {
  const enqueued: string[] = [];
  const scheduler: EnqueueOptions["scheduler"] = {
    mustWait: () => waits,
    enqueue: (job) => void enqueued.push(job.id),
  };
  return { scheduler, enqueued };
}

function fakeClient(ts: string) {
  const posts: SlackMessage[] = [];
  const client = {
    chat: {
      postMessage: async (message: SlackMessage) => {
        posts.push(message);
        return { ts };
      },
      update: async () => ({}),
    },
  };
  return { client, posts };
}

test('says "Added … to the queue" only when the job has to wait', async (t) => {
  const { db } = await tempDatabase(t);
  const deploy = bundledCommand("deploy");
  const status = bundledCommand("status");
  const { client, posts } = fakeClient("1.1");
  const enqueued: string[] = [];
  const enqueue = (command: typeof deploy, waits: boolean, jobId: string) => {
    const fake = fakeScheduler(waits);
    return enqueueJob({
      client,
      db,
      scheduler: fake.scheduler,
      command,
      input: { ticket: "ABC-111" },
      channelId: "D1",
      userId: "U1",
      jobId,
    }).then(() => enqueued.push(...fake.enqueued));
  };

  await enqueue(deploy, false, "job-1");
  await enqueue(deploy, true, "job-2");
  await enqueue(status, false, "job-3");
  await enqueue(status, true, "job-4");

  assert.deepEqual(
    posts.map((post) => post.text),
    [
      "#1 Running `gcmd deploy --ticket ABC-111`",
      "Added #2 `gcmd deploy --ticket ABC-111` to the queue",
      "#3 Running `gcmd status --ticket ABC-111`",
      "Added #4 `gcmd status --ticket ABC-111` to the queue",
    ],
  );
  assert.equal(getJob(db, "job-1")?.announced, true);
  assert.equal(getJob(db, "job-2")?.announced, false);
  assert.deepEqual(enqueued, ["job-1", "job-2", "job-3", "job-4"]);
});

test("prompt messages name the job that is asking", () => {
  assert.equal(
    promptMessage(
      "job-12",
      "Are you sure you want to deploy ABC-1 to production? [Y/n]",
    ),
    "❓ [#12] Are you sure you want to deploy ABC-1 to production? [Y/n]",
  );
});

test("final-state messages @mention the creator in channels but not in DMs", () => {
  assert.equal(mentionCreator({ channelId: "C1", userId: "UB" }), "<@UB> ");
  assert.equal(mentionCreator({ channelId: "G1", userId: "UB" }), "<@UB> ");
  assert.equal(mentionCreator({ channelId: "D1", userId: "UB" }), "");
});

test("isDirectMessage recognises DM conversation ids", () => {
  assert.equal(isDirectMessage("D0123"), true);
  assert.equal(isDirectMessage("C0123"), false);
  assert.equal(isDirectMessage("G0123"), false);
});

test("enqueueJob posts top-level in DMs and threads in channels", async (t) => {
  const { db } = await tempDatabase(t);
  const { client, posts } = fakeClient("200.1");
  const options = {
    client,
    db,
    scheduler: fakeScheduler().scheduler,
    command: bundledCommand("deploy"),
    input: { ticket: "ABC-1" },
    userId: "U1",
  };

  await enqueueJob({
    ...options,
    channelId: "D1",
    replyThreadTs: "9.9",
    jobId: "job-1",
  });
  await enqueueJob({ ...options, channelId: "C1", jobId: "job-2" });
  await enqueueJob({
    ...options,
    channelId: "C1",
    replyThreadTs: "5.5",
    jobId: "job-3",
  });

  assert.equal(posts[0].thread_ts, undefined);
  assert.equal(posts[0].text, "#1 Running `gcmd deploy --ticket ABC-1`");
  assert.equal(getJob(db, "job-1")?.threadTs, undefined);
  assert.equal(getJob(db, "job-2")?.threadTs, "200.1");
  assert.equal(posts[2].thread_ts, "5.5");
  assert.equal(getJob(db, "job-3")?.threadTs, "5.5");
});

test("formatCommand shows the exact command line an command will run", () => {
  assert.equal(
    formatCommand(bundledCommand("deploy").build({ ticket: "ABC-11" })),
    "gcmd deploy --ticket ABC-11",
  );
});

test("job ids are BullMQ-safe and render as #N", () => {
  assert.equal(toJobId(3), "job-3");
  assert.equal(jobLabel("job-3"), "#3");
  // BullMQ rejects custom ids where `${parseInt(id, 10)}` === id, and ids containing ':'.
  const id = toJobId(42);
  assert.notEqual(`${parseInt(id, 10)}`, id);
  assert.ok(!id.includes(":"));
});
