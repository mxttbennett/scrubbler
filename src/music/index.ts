import { runMusic } from './cli.js';

process.exitCode = await runMusic(process.argv.slice(2));
