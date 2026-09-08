import { openSync, closeSync, readFileSync, unlinkSync, writeSync, ftruncateSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class AlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`another scrubbler is already running (pid ${pid})`);
    this.name = 'AlreadyRunningError';
  }
}

function alive(pid: number): boolean {
  try {
    // signal 0 tests for existence without delivering anything
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not ours to signal — that is still alive. Only ESRCH
    // means it is gone, so catching both as "dead" would take over a live lock.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Refuses to start a second instance. Two writers could both POST the same tuple, and a restart that
 * left the previous process draining outside its cgroup has already happened once in production.
 */
export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });

  let existing: number | undefined;
  try {
    existing = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  } catch {
    // no lock file is the normal first-run case
  }

  if (existing !== undefined && Number.isInteger(existing) && existing !== process.pid) {
    if (alive(existing)) throw new AlreadyRunningError(existing);
    // a stale file from a killed process is safe to take over
  }

  const fd = openSync(path, 'w');
  ftruncateSync(fd, 0);
  writeSync(fd, String(process.pid));
  closeSync(fd);

  return () => {
    try {
      const owner = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (owner === process.pid) unlinkSync(path);
    } catch {
      // releasing a lock we no longer own, or that is already gone, is not an error
    }
  };
}

export function lockPath(dbPath: string): string {
  return `${dirname(dbPath)}/scrubbler.lock`;
}
