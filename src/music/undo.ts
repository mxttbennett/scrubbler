import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PERSISTENT_ID_PATTERN, type MusicChange } from './planner.js';

const HEADER = ['persistent ID', 'field', 'original', 'new'];

export function encodeUndo(changes: MusicChange[]): string {
  const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  return [HEADER.join(','), ...changes.map((change) => [change.persistentId, change.field, change.original, change.new].map(quote).join(','))].join('\r\n') + '\r\n';
}

export function parseUndo(csv: string): MusicChange[] {
  const text = csv.startsWith('\uFEFF') ? csv.slice(1) : csv;
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let state: 'start' | 'unquoted' | 'quoted' | 'closed' = 'start';
  const finishCell = (): void => { row.push(cell); cell = ''; state = 'start'; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (state === 'quoted') {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else state = 'closed';
      } else cell += ch;
      continue;
    }
    if (ch === ',') finishCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r') {
        if (text[i + 1] !== '\n') throw new Error('Malformed CSV record ending');
        i++;
      }
      finishCell();
      records.push(row);
      row = [];
    } else if (ch === '"' && state === 'start') state = 'quoted';
    else {
      if (ch === '"' || state === 'closed') throw new Error('Malformed CSV quoting');
      state = 'unquoted';
      cell += ch;
    }
  }
  if (state === 'quoted') throw new Error('Unterminated CSV quoted field');
  if (row.length || state !== 'start') { finishCell(); records.push(row); }
  const header = records.shift();
  if (!header || header.length !== 4 || header.some((value, i) => value !== HEADER[i])) throw new Error('Invalid undo CSV header');
  const keys = new Set<string>();
  return records.map((record) => {
    if (record.length !== 4) throw new Error('Undo CSV requires four columns');
    const [persistentId, field, original, target] = record as [string, string, string, string];
    if (!PERSISTENT_ID_PATTERN.test(persistentId)) throw new Error('Invalid undo persistent ID');
    if (field !== 'name' && field !== 'album') throw new Error('Invalid undo field');
    const key = JSON.stringify([persistentId.toUpperCase(), field]);
    if (keys.has(key)) throw new Error('Duplicate undo field');
    keys.add(key);
    return { persistentId, field, original, new: target };
  });
}

export function reverseChanges(changes: MusicChange[]): MusicChange[] {
  return changes.map((change) => ({ ...change, original: change.new, new: change.original }));
}

export interface BackupFile {
  writeFile(csv: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface BackupFilesystem {
  mkdir(path: string): Promise<unknown>;
  open(path: string, flag: 'wx'): Promise<BackupFile>;
}

export async function createBackup(changes: MusicChange[], options: {
  directory?: string;
  now?: () => Date;
  fs?: BackupFilesystem;
} = {}): Promise<string> {
  const directory = resolve(options.directory ?? '.data/music');
  const timestamp = (options.now ?? (() => new Date()))().toISOString().slice(0, 19).replaceAll(':', '-');
  const path = resolve(directory, `undo-${timestamp}.csv`);
  const csv = encodeUndo(changes);
  const fs = options.fs ?? { mkdir: (dir: string) => mkdir(dir, { recursive: true }), open };
  await fs.mkdir(directory);
  const file = await fs.open(path, 'wx');
  try {
    await file.writeFile(csv);
    await file.sync();
  } finally {
    await file.close();
  }
  return path;
}
