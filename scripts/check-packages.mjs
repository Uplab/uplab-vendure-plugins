#!/usr/bin/env node
/**
 * Packaging hygiene for every publishable package:
 *  - publint: the published shape (files/exports/main/types) is consistent
 *  - attw --pack: the types resolve under every TypeScript resolution mode
 * Both run against the real packed tarball — the check that was missing when Pinelab
 * shipped three plugin versions without dist/dashboard in the tarball (#717).
 *  - LICENSE: the package carries an exact copy of the root LICENSE and the packed tarball
 *    contains it. npm only ships a LICENSE that sits in the package directory, and releases
 *    run `npm publish` there, so the root file alone never reaches npm.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const rootLicense = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');

const workspace = JSON.parse(execFileSync('pnpm', ['-r', 'ls', '--json', '--depth', '-1'], { encoding: 'utf8' }));
const publishable = workspace.filter((pkg) => pkg.private !== true);

if (publishable.length === 0) {
  console.error('No publishable packages found — check the workspace filters.');
  process.exit(1);
}

/** Returns the reason the package's LICENSE is wrong, or `null` when it ships the root one. */
function licenseProblem(pkg) {
  const file = join(pkg.path, 'LICENSE');
  if (!existsSync(file)) return 'no LICENSE in the package directory (copy the root LICENSE there)';
  if (readFileSync(file, 'utf8') !== rootLicense) return 'LICENSE differs from the root LICENSE (copy it again)';
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkg.path, encoding: 'utf8' }),
  );
  if (!packed.files.some((entry) => entry.path === 'LICENSE')) return 'LICENSE is not in the packed tarball';
  return null;
}

let failed = false;
for (const pkg of publishable) {
  console.log(`\n> ${pkg.name}: LICENSE`);
  const problem = licenseProblem(pkg);
  if (problem) {
    console.error(`${pkg.name}: ${problem}`);
    failed = true;
  } else {
    console.log('LICENSE matches the root one and is in the tarball.');
  }

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
