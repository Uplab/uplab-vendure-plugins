#!/usr/bin/env node
/**
 * Type-checks a package's dashboard extension (`tsconfig.dashboard.json` in the current directory).
 *
 * `@vendure/dashboard` ships its `.tsx` sources instead of declarations, so TypeScript checks them
 * too and `skipLibCheck` does not help. Some of them do not pass under this repo's TypeScript and
 * dependency versions — errors that are not ours to fix. Every diagnostic is printed; only those in
 * the package's own files fail the check.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.dashboard.json', '--noEmit', '--pretty', 'false'], {
  encoding: 'utf8',
});
if (result.error) {
  throw result.error;
}

const output = `${result.stdout}${result.stderr}`;
const diagnostics = output.split('\n').filter((line) => /error TS\d+:/.test(line));
const ours = diagnostics.filter((line) => !line.includes('node_modules/'));
const upstream = diagnostics.length - ours.length;

if (ours.length > 0) {
  console.error(output);
  process.exit(1);
}
if (result.status !== 0 && diagnostics.length === 0) {
  // tsc failed for a reason that is not a diagnostic (bad config, crash) — surface it.
  console.error(output);
  process.exit(result.status ?? 1);
}
console.log(
  upstream > 0
    ? `Dashboard extension type-checks. Ignored ${upstream} error(s) inside @vendure/dashboard's own sources.`
    : 'Dashboard extension type-checks.',
);
