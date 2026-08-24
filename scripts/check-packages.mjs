#!/usr/bin/env node
/**
 * Packaging hygiene for every publishable package:
 *  - publint: the published shape (files/exports/main/types) is consistent
 *  - attw --pack: the types resolve under every TypeScript resolution mode
 * Both run against the real packed tarball — the check that was missing when Pinelab
 * shipped three plugin versions without dist/dashboard in the tarball (#717).
 */
import { execFileSync, spawnSync } from 'node:child_process';

const workspace = JSON.parse(execFileSync('pnpm', ['-r', 'ls', '--json', '--depth', '-1'], { encoding: 'utf8' }));
const publishable = workspace.filter((pkg) => pkg.private !== true);

if (publishable.length === 0) {
  console.error('No publishable packages found — check the workspace filters.');
  process.exit(1);
}

let failed = false;
for (const pkg of publishable) {
  for (const args of [
    ['exec', 'publint', '--strict'],
    ['exec', 'attw', '--pack', '.'],
  ]) {
    console.log(`\n> ${pkg.name}: ${args.slice(1).join(' ')}`);
    const res = spawnSync('pnpm', args, { cwd: pkg.path, stdio: 'inherit' });
    if (res.status !== 0) failed = true;
  }
}

process.exit(failed ? 1 : 0);
