import test from "node:test";
import assert from "node:assert/strict";
import { validateTicket } from "../src/shared/validators.ts";

test("accepts a valid ticket", () => {
  assert.equal(validateTicket("ABC-123"), "ABC-123");
});

test("rejects invalid or injectable ticket values", () => {
  for (const ticket of [
    "",
    "ABC-123",
    "ABC-abc",
    "ABC-123; whoami",
    "ABC-123 && whoami",
    undefined,
    123,
  ]) {
    assert.throws(() => validateTicket(ticket));
  }
});
