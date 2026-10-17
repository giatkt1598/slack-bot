const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

async function createDatabase(filename) {
  const directory = path.dirname(path.resolve(filename));
  fs.mkdirSync(directory, { recursive: true });
  const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
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

function persist(db, filename) {
  fs.writeFileSync(filename, Buffer.from(db.export()));
}

function insertJob(database, job) {
  const { db, filename } = database;
  db.run(`
    INSERT INTO jobs (id, action, input_json, status, slack_channel_id, slack_thread_ts, slack_user_id, created_at, announced)
    VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
  `, [job.id, job.action, job.inputJson, job.channelId, job.threadTs, job.userId, job.createdAt, job.announced === false ? 0 : 1]);
  persist(db, filename);
}

function updateJob(database, id, patch) {
  const { db, filename } = database;
  const allowed = ['status', 'startedAt', 'finishedAt', 'exitCode', 'outputSummary', 'errorSummary', 'announced'];
  const columns = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!columns.length) return;
  const names = columns.map((key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  db.run(`UPDATE jobs SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE id = ?`, [...columns.map((key) => patch[key] ?? null), id]);
  persist(db, filename);
}

function queryOne(db, sql, params) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
  }
}

function toJob(row) {
  return row && {
    id: row.id,
    action: row.action,
    input: JSON.parse(row.input_json),
    status: row.status,
    channelId: row.slack_channel_id,
    // '' means the job lives in a DM without a thread; undefined makes Slack calls post top-level.
    threadTs: row.slack_thread_ts || undefined,
    userId: row.slack_user_id,
    announced: row.announced !== 0
  };
}

function getJob(database, id) {
  return toJob(queryOne(database.db, 'SELECT * FROM jobs WHERE id = ?', [id]));
}

// The newest unfinished job whose status updates live in this Slack thread.
function findActiveJobByThread(database, channelId, threadTs) {
  return toJob(queryOne(database.db, `
    SELECT * FROM jobs
    WHERE slack_channel_id = ? AND slack_thread_ts = ? AND status IN ('queued', 'running', 'waiting_input')
    ORDER BY created_at DESC LIMIT 1
  `, [channelId, threadTs]));
}

// The newest job in this conversation that is waiting for an answer (used for flat DM conversations).
function findWaitingJobInChannel(database, channelId) {
  return toJob(queryOne(database.db, `
    SELECT * FROM jobs WHERE slack_channel_id = ? AND status = 'waiting_input'
    ORDER BY created_at DESC LIMIT 1
  `, [channelId]));
}

// Highest N among job ids of the form "job-N" (older rows used UUIDs and are ignored).
function maxJobNumber(database) {
  const row = queryOne(database.db, "SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) AS n FROM jobs WHERE id LIKE 'job-%'", []);
  return row?.n || 0;
}

module.exports = { createDatabase, insertJob, updateJob, getJob, findActiveJobByThread, findWaitingJobInChannel, maxJobNumber };
