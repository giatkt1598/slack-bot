import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import type { Database as SqlDatabase, ParamsObject, SqlValue } from 'sql.js';
import type { JobRecord, JobStatus } from '../types.ts';

const require = createRequire(import.meta.url);

export interface Database {
  db: SqlDatabase;
  filename: string;
}

export interface NewJob {
  id: string;
  // Stored in the `action` column (the name predates the action → command rename).
  command: string;
  inputJson: string;
  channelId: string;
  // '' = no thread (DM conversation).
  threadTs: string;
  userId: string;
  createdAt: string;
  announced?: boolean;
}

export interface JobPatch {
  status?: JobStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  outputSummary?: string;
  errorSummary?: string;
  announced?: number;
}

export async function createDatabase(filename: string): Promise<Database> {
  const directory = path.dirname(path.resolve(filename));
  fs.mkdirSync(directory, { recursive: true });
  const SQL = await initSqlJs({ locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`) });
  const db = fs.existsSync(filename) ? new SQL.Database(fs.readFileSync(filename)) : new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      input_json TEXT NOT NULL,
      status TEXT NOT NULL,
      slack_channel_id TEXT NOT NULL,
      slack_thread_ts TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      exit_code INTEGER,
      output_summary TEXT,
      error_summary TEXT,
      announced INTEGER NOT NULL DEFAULT 1
    );
  `);
  // announced = the "#N Đang chạy lệnh …" message was posted. Older databases lack the column;
  // their rows already got that message, hence DEFAULT 1.
  const columns = db.exec('PRAGMA table_info(jobs)')[0].values.map((column) => column[1]);
  if (!columns.includes('announced')) db.run('ALTER TABLE jobs ADD COLUMN announced INTEGER NOT NULL DEFAULT 1');
  persist(db, filename);
  return { db, filename };
}

function persist(db: SqlDatabase, filename: string): void {
  fs.writeFileSync(filename, Buffer.from(db.export()));
}

export function insertJob(database: Database, job: NewJob): void {
  const { db, filename } = database;
  db.run(`
    INSERT INTO jobs (id, action, input_json, status, slack_channel_id, slack_thread_ts, slack_user_id, created_at, announced)
    VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
  `, [job.id, job.command, job.inputJson, job.channelId, job.threadTs, job.userId, job.createdAt, job.announced === false ? 0 : 1]);
  persist(db, filename);
}

export function updateJob(database: Database, id: string, patch: JobPatch): void {
  const { db, filename } = database;
  const allowed: (keyof JobPatch)[] = ['status', 'startedAt', 'finishedAt', 'exitCode', 'outputSummary', 'errorSummary', 'announced'];
  const columns = (Object.keys(patch) as (keyof JobPatch)[]).filter((key) => allowed.includes(key));
  if (!columns.length) return;
  const names = columns.map((key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  const values: SqlValue[] = columns.map((key) => patch[key] ?? null);
  db.run(`UPDATE jobs SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE id = ?`, [...values, id]);
  persist(db, filename);
}

function queryOne(db: SqlDatabase, sql: string, params: SqlValue[]): ParamsObject | null {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
  }
}

function toJob(row: ParamsObject | null): JobRecord | null {
  return row && {
    id: String(row.id),
    command: String(row.action),
    input: JSON.parse(String(row.input_json)),
    status: row.status as JobStatus,
    channelId: String(row.slack_channel_id),
    // '' means the job lives in a DM without a thread; undefined makes Slack calls post top-level.
    threadTs: row.slack_thread_ts ? String(row.slack_thread_ts) : undefined,
    userId: String(row.slack_user_id),
    announced: row.announced !== 0
  };
}

export function getJob(database: Database, id: string): JobRecord | null {
  return toJob(queryOne(database.db, 'SELECT * FROM jobs WHERE id = ?', [id]));
}

// The newest unfinished job whose status updates live in this Slack thread.
export function findActiveJobByThread(database: Database, channelId: string, threadTs: string): JobRecord | null {
  return toJob(queryOne(database.db, `
    SELECT * FROM jobs
    WHERE slack_channel_id = ? AND slack_thread_ts = ? AND status IN ('queued', 'running', 'waiting_input')
    ORDER BY created_at DESC LIMIT 1
  `, [channelId, threadTs]));
}

// The newest job in this conversation that is waiting for an answer (used for flat DM conversations).
export function findWaitingJobInChannel(database: Database, channelId: string): JobRecord | null {
  return toJob(queryOne(database.db, `
    SELECT * FROM jobs WHERE slack_channel_id = ? AND status = 'waiting_input'
    ORDER BY created_at DESC LIMIT 1
  `, [channelId]));
}

// Jobs in the given statuses, oldest first (used to recover after a restart).
export function listJobs(database: Database, statuses: JobStatus[]): JobRecord[] {
  const statement = database.db.prepare(
    `SELECT * FROM jobs WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at, id`
  );
  try {
    statement.bind(statuses);
    const jobs: JobRecord[] = [];
    while (statement.step()) jobs.push(toJob(statement.getAsObject())!);
    return jobs;
  } finally {
    statement.free();
  }
}

// Highest N among job ids of the form "job-N" (older rows used UUIDs and are ignored).
export function maxJobNumber(database: Database): number {
  const row = queryOne(database.db, "SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) AS n FROM jobs WHERE id LIKE 'job-%'", []);
  return Number(row?.n) || 0;
}
