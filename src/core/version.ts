import { createRequire } from 'node:module';

/**
 * package.json sits outside rootDir so it cannot be imported, and it is two levels up from both
 * src/core/ under tsx and dist/core/ in the deployed tree — the same path serves both.
 */
export function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
