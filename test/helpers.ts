import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { actions } from '../src/actions/index.ts';
import { createDatabase } from '../src/shared/db.ts';
import type { Action } from '../src/types.ts';

// A fresh SQLite file in a temp directory, removed when the test ends.
export async function tempDatabase(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-bot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'jobs.sqlite');
  return { filename, db: await createDatabase(filename) };
}

export function bundledAction(name: string): Action {
  const action = actions.find((candidate) => candidate.name === name);
  if (!action) throw new Error(`No bundled action ${name}`);
  return action;
}
