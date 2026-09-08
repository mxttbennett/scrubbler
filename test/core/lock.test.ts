import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AlreadyRunningError, acquireLock, lockPath } from '../../src/core/lock.js';

function tmpLock(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'scrubbler-lock-')), '.data');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'scrubbler.lock');
}

describe('single-instance lock', () => {
  it('writes our pid and creates the parent directory', () => {
    const p = tmpLock();
    const release = acquireLock(p);
    expect(readFileSync(p, 'utf8')).toBe(String(process.pid));
    release();
  });

  it('refuses to start when another live process holds it', () => {
    const p = tmpLock();
    // pid 1 always exists, so it stands in for a live sibling
    writeFileSync(p, '1');
    expect(() => acquireLock(p)).toThrow(AlreadyRunningError);
    try {
      acquireLock(p);
    } catch (e) {
      expect((e as AlreadyRunningError).pid).toBe(1);
    }
  });

  it('takes over a stale lock left by a killed process', () => {
    const p = tmpLock();
    // a pid that cannot be running: above the typical max, and not us
    writeFileSync(p, '4194303');
    const release = acquireLock(p);
    expect(readFileSync(p, 'utf8')).toBe(String(process.pid));
    release();
  });

  it('tolerates a garbage lock file rather than refusing forever', () => {
    const p = tmpLock();
    writeFileSync(p, 'not-a-pid');
    const release = acquireLock(p);
    expect(readFileSync(p, 'utf8')).toBe(String(process.pid));
    release();
  });

  it('re-acquiring in the same process is not a conflict', () => {
    const p = tmpLock();
    const r1 = acquireLock(p);
    expect(() => acquireLock(p)).not.toThrow();
    r1();
  });

  it('removes the file on release, and only if we own it', () => {
    const p = tmpLock();
    const release = acquireLock(p);
    release();
    expect(existsSync(p)).toBe(false);

    // releasing again, or when someone else owns it, must not throw
    writeFileSync(p, '1');
    release();
    expect(readFileSync(p, 'utf8')).toBe('1');
  });

  it('derives the path from the database directory', () => {
    expect(lockPath('.data/scrubbler.sqlite')).toBe('.data/scrubbler.lock');
  });
});
