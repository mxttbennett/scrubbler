import { readFile } from 'node:fs/promises';
import { DEFAULT_ENABLED } from '../rules/markers.js';
import { discoverMusic, type ScriptRunner } from './osascript.js';
import { displayValue, formatPreview, planMusic, type MusicChange } from './planner.js';
import { applyMusic, executeChanges } from './executor.js';
import { parseUndo, reverseChanges } from './undo.js';

export interface MusicDependencies {
  runScript?: ScriptRunner;
  output?: (message: string) => void;
  readFile?: (path: string) => Promise<string>;
  backup?: (changes: MusicChange[]) => Promise<string>;
}

type Mode = { kind: 'preview' | 'apply' | 'help' } | { kind: 'undo'; path: string };

function parseArgs(args: string[]): Mode {
  let mode: Mode = { kind: 'preview' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (mode.kind !== 'preview') throw new Error('Choose only one of --apply, --undo <csv>, or --help');
    if (arg === '--apply') mode = { kind: 'apply' };
    else if (arg === '--help') mode = { kind: 'help' };
    else if (arg === '--undo') {
      const path = args[++i];
      if (!path || path.startsWith('--')) throw new Error('--undo requires a CSV path');
      mode = { kind: 'undo', path };
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return mode;
}

export async function runMusic(args: string[], deps: MusicDependencies = {}): Promise<number> {
  const output = deps.output ?? console.log;
  try {
    const mode = parseArgs(args);
    if (mode.kind === 'help') {
      output('Usage: npm run music -- [--apply | --undo <csv> | --help]\nNo flags: preview only. --apply: save undo CSV and apply. --undo: explicitly restore CSV values.');
      return 0;
    }
    if (mode.kind === 'undo') {
      const csv = await (deps.readFile ?? ((path: string) => readFile(path, 'utf8')))(mode.path);
      const changes = reverseChanges(parseUndo(csv));
      output(`Music undo: requested restoration changes from ${displayValue(mode.path)}; eligibility checked during each write.`);
      for (const change of changes) {
        output(`restore [${change.persistentId}] ${change.field}: ${displayValue(change.original)} -> ${displayValue(change.new)}`);
      }
      return (await executeChanges(changes, deps)).exitCode;
    }
    output(`Music ${mode.kind}: active groups ${DEFAULT_ENABLED.join(', ')}; no environment, database, custom, or ignore overrides.`);
    const plan = planMusic(await discoverMusic(deps.runScript));
    output(formatPreview(plan));
    if (mode.kind === 'preview' || plan.changes.length === 0) return 0;
    return (await applyMusic(plan.changes, deps)).exitCode;
  } catch (error) {
    output(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
