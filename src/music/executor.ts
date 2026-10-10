import { runScript, WRITER_SCRIPT, type ScriptRunner } from './osascript.js';
import { displayValue, type MusicChange } from './planner.js';
import { createBackup } from './undo.js';

export interface MusicResult {
  persistentId: string;
  field: MusicChange['field'];
  status: 'applied' | 'already-target' | 'conflict' | 'failed';
  diagnostic: string;
}

export interface MusicExecution {
  results: MusicResult[];
  unknown: number;
  notSubmitted: number;
  error: string | null;
  exitCode: number;
}

export interface ExecutorDependencies {
  runScript?: ScriptRunner;
  output?: (message: string) => void;
}

function parseResults(stdout: string, changes: MusicChange[]): MusicResult[] {
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value) || value.length !== changes.length) throw new Error('Music writer returned an incomplete result set');
  const key = (id: string, field: string): string => JSON.stringify([id, field]);
  const expected = new Set(changes.map((change) => key(change.persistentId, change.field)));
  const results = value.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') throw new Error('Invalid Music writer result');
    const row = entry as Record<string, unknown>;
    if (typeof row.persistentId !== 'string' || (row.field !== 'name' && row.field !== 'album') ||
      typeof row.status !== 'string' || !['applied', 'already-target', 'conflict', 'failed'].includes(row.status) || typeof row.diagnostic !== 'string') {
      throw new Error('Invalid Music writer result');
    }
    if (!expected.delete(key(row.persistentId, row.field))) throw new Error('Duplicate or unexpected Music writer result');
    return row as unknown as MusicResult;
  });
  if (expected.size) throw new Error('Missing Music writer results');
  return results;
}

export async function executeChanges(changes: MusicChange[], deps: ExecutorDependencies = {}): Promise<MusicExecution> {
  const runner = deps.runScript ?? runScript;
  const output = deps.output ?? console.log;
  const grouped = new Map<string, { persistentId: string; changes: MusicChange[] }>();
  for (const change of changes) {
    let group = grouped.get(change.persistentId);
    if (!group) { group = { persistentId: change.persistentId, changes: [] }; grouped.set(change.persistentId, group); }
    group.changes.push(change);
  }
  const tracks = [...grouped.values()];
  const execution: MusicExecution = { results: [], unknown: 0, notSubmitted: 0, error: null, exitCode: 0 };
  for (let i = 0; i < tracks.length; i += 100) {
    const batch = tracks.slice(i, i + 100);
    const submitted = batch.flatMap((track) => track.changes);
    let results: MusicResult[];
    try {
      results = parseResults(await runner(WRITER_SCRIPT, [JSON.stringify(batch)]), submitted);
    } catch (error) {
      execution.unknown = submitted.length;
      execution.notSubmitted = changes.length - execution.results.length - submitted.length;
      execution.error = error instanceof Error ? error.message : String(error);
      execution.exitCode = 1;
      output(`Batch outcome unknown: ${displayValue(execution.error)}. Stopped without retry or rollback.`);
      break;
    }
    execution.results.push(...results);
    for (const result of results) {
      if (result.status === 'conflict' || result.status === 'failed') execution.exitCode = 1;
      output(`${result.status} [${result.persistentId}] ${result.field}${result.diagnostic ? `: ${displayValue(result.diagnostic)}` : ''}`);
    }
  }
  const count = (status: MusicResult['status']): number => execution.results.filter((result) => result.status === status).length;
  output(`Fields: applied ${count('applied')}; already-target ${count('already-target')}; conflict ${count('conflict')}; failed ${count('failed')}; unknown ${execution.unknown}; not submitted ${execution.notSubmitted}`);
  return execution;
}

export async function applyMusic(changes: MusicChange[], deps: ExecutorDependencies & {
  backup?: (changes: MusicChange[]) => Promise<string>;
} = {}): Promise<MusicExecution> {
  if (changes.length) {
    const path = await (deps.backup ?? createBackup)(changes);
    (deps.output ?? console.log)(`Undo CSV: ${path}`);
  }
  return executeChanges(changes, deps);
}
