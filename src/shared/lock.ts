import fs from 'node:fs';
import path from 'node:path';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Ensures only one bot process runs: two would split Slack events between them and both rewrite the SQLite file.
 * Creates `filename` holding this PID; a lock left by a dead process is taken over. Returns a release function.
 */
export function acquireLock(filename: string): () => void {
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(filename, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(filename, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(filename, 'utf8'));
      if (pid && pid !== process.pid && isAlive(pid)) {
        throw new Error(`The bot is already running in another process (PID ${pid}). Only one instance may run. Lock file: ${path.resolve(filename)}`);
      }
      fs.rmSync(filename, { force: true });
    }
  }
  throw new Error(`Could not acquire lock ${path.resolve(filename)}`);
}
