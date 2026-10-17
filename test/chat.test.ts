import test from "node:test";
import assert from "node:assert/strict";
import { commands } from "../src/commands/index.ts";
import {
  createChatParser,
  isQueueCommand,
  parseCancel,
  toPlainText,
} from "../src/bot/chat.ts";

test('isQueueCommand matches only the bare "queue" command', () => {
  for (const text of ["queue", "Queue", " queue ", "/queue", "<@U1> queue"])
    assert.equal(isQueueCommand(text), true);
  for (const text of ["queues", "queue #3", "show queue", "", undefined])
    assert.equal(isQueueCommand(text), false);
});

test('parseCancel accepts "cancel #N" in its usual spellings', () => {
  for (const text of [
    "cancel #3",
    "cancel 3",
    "Cancel  #3 ",
    "<@U1> cancel #3",
    "/cancel #3",
  ]) {
    assert.deepEqual(parseCancel(text), { number: 3 });
  }
  for (const text of ["cancel", "cancel abc", "cancel #3 #4", "cancel #"]) {
    assert.deepEqual(parseCancel(text), { number: null });
  }
  for (const text of [
    "deploy ABC-1",
    "cancelled",
    "please cancel #3",
    "Y",
    "",
  ]) {
    assert.equal(parseCancel(text), null);
  }
});

const { parseCommand, helpText } = createChatParser(commands);
const parsed = (text: string | undefined) => {
  const result = parseCommand(text);
  return result && { name: result.command.name, args: result.args };
};

test("parses commands from mentions and DMs, with or without slash", () => {
  assert.deepEqual(parsed("<@U123> /deploy ABC-123"), {
    name: "deploy",
    args: "ABC-123",
  });
  assert.deepEqual(parsed("<@U123> deploy ABC-XXX"), {
    name: "deploy",
    args: "ABC-XXX",
  });
  assert.deepEqual(parsed("  Deploy   ABC-1 "), {
    name: "deploy",
    args: "ABC-1",
  });
  assert.deepEqual(parsed("status ABC-9"), { name: "status", args: "ABC-9" });
  assert.deepEqual(parsed("deploy"), { name: "deploy", args: "" });
});

test("returns null for unknown or empty text", () => {
  for (const text of [
    "hello",
    "",
    undefined,
    "<@U123>",
    "deployx ABC-1",
    "please deploy ABC-1",
  ]) {
    assert.equal(parseCommand(text), null);
  }
});

test("help text lists every registered command", () => {
  const text = helpText();
  assert.match(text, /^Supported commands:/);
  for (const { usage } of commands) assert.ok(text.includes(usage));
  assert.ok(text.includes("cancel #3"));
  assert.ok(text.includes("`queue`"));
});

test("toPlainText strips mentions and decodes Slack escaping", () => {
  assert.equal(toPlainText("<@U1> a &lt;b&gt; &amp; c"), "a <b> & c");
  assert.equal(toPlainText("<@U1>"), "");
});
