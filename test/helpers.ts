import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { commands } from '../src/commands/index.ts';
import { createDatabase } from '../src/shared/db.ts';
import type { Command } from '../src/types.ts';

// A fresh SQLite file in a temp directory, removed when the test ends.
export async function tempDatabase(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-bot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'jobs.sqlite');
  return { filename, db: await createDatabase(filename) };
}

export function bundledCommand(name: string): Command {
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) throw new Error(`No bundled command ${name}`);
  return command;
}
