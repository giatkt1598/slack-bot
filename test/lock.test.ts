import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLock } from '../src/shared/lock.ts';

function tempLockPath(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-bot-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'slack-bot.lock');
}

test('only one holder at a time; released locks can be taken again', (t) => {
  const file = tempLockPath(t);
  // Simulate another live process holding the lock: the parent of this test process is alive.
  fs.writeFileSync(file, String(process.ppid));
  assert.throws(() => acquireLock(file), /đang chạy ở tiến trình khác/);

  fs.rmSync(file);
  const release = acquireLock(file);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  release();
  assert.equal(fs.existsSync(file), false);
  acquireLock(file)();
});

test('a lock left by a dead process is taken over', (t) => {
  const file = tempLockPath(t);
  // A PID that existed but has exited.
  const deadPid = spawnSync(process.execPath, ['-e', 'console.log(process.pid)']).stdout.toString().trim();
  fs.writeFileSync(file, deadPid);
  const release = acquireLock(file);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  release();
});
