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
      error_summary TEXT
    );
  `);
  persist(db, filename);
  return { db, filename };
}

function persist(db, filename) {
  fs.writeFileSync(filename, Buffer.from(db.export()));
}

function insertJob(database, job) {
  const { db, filename } = database;
  db.run(`
    INSERT INTO jobs (id, action, input_json, status, slack_channel_id, slack_thread_ts, slack_user_id, created_at)
    VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
  `, [job.id, job.action, job.inputJson, job.channelId, job.threadTs, job.userId, job.createdAt]);
  persist(db, filename);
}

function updateJob(database, id, patch) {
  const { db, filename } = database;
  const allowed = ['status', 'startedAt', 'finishedAt', 'exitCode', 'outputSummary', 'errorSummary'];
  const columns = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!columns.length) return;
  const names = columns.map((key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  db.run(`UPDATE jobs SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE id = ?`, [...columns.map((key) => patch[key]), id]);
  persist(db, filename);
}

module.exports = { createDatabase, insertJob, updateJob };
