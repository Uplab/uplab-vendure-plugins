#!/usr/bin/env node
/**
 * Publishes every public workspace package whose current version is not yet on npm, then
 * creates the git tags changesets expects (`<name>@<version>`).
 *
 * Why not `changeset publish`? It shells out to `pnpm publish` whenever it detects pnpm, and
 * `pnpm publish` with npm trusted publishing (OIDC) has been reported to fail where a plain
 * `npm publish` succeeds (pnpm/pnpm#9812). Publishing through the npm CLI directly keeps the
 * OIDC + provenance path exactly the one npm documents.
 *
 * Usage:
 *   node scripts/release.mjs            # publish + tag
 *   node scripts/release.mjs --dry-run  # only report what would be published
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dryRun = process.argv.includes('--dry-run');

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}`);
  }
}

function isPublished(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    encoding: 'utf8',
  });
  // `npm view` exits non-zero with E404 when the version (or the whole package) is missing.
  if (result.status !== 0) {
    if (/E404/.test(result.stderr ?? '')) return false;
    throw new Error(`npm view ${name}@${version} failed:\n${result.stderr}`);
  }
  return result.stdout.trim() !== '';
}

const workspace = JSON.parse(execFileSync('pnpm', ['-r', 'ls', '--json', '--depth', '-1'], { encoding: 'utf8' }));

const candidates = workspace
  .map((pkg) => ({ ...pkg, manifest: JSON.parse(readFileSync(join(pkg.path, 'package.json'), 'utf8')) }))
  .filter((pkg) => pkg.manifest.private !== true);

const toPublish = candidates.filter((pkg) => !isPublished(pkg.name, pkg.version));

if (toPublish.length === 0) {
  console.log('Nothing to publish: every public package version is already on npm.');
  process.exit(0);
}

for (const pkg of toPublish) {
  console.log(`${dryRun ? '[dry-run] would publish' : 'Publishing'} ${pkg.name}@${pkg.version}`);
  if (dryRun) continue;
  run('npm', ['publish', '--access', 'public', '--provenance'], { cwd: pkg.path });
}

if (!dryRun) {
  // `changeset tag` tags the current version of every package; it skips tags that already exist.
  run('pnpm', ['exec', 'changeset', 'tag']);
}
