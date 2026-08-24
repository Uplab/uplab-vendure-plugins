/**
 * PostToolUse hook: prettier-formats the file that was just written or edited.
 * Prettier respects .prettierignore, so generated files are skipped automatically.
 * Formatting failures are non-blocking.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const file = input?.tool_input?.file_path;
if (file && existsSync(file) && /\.(ts|tsx|mts|cts|js|mjs|cjs|json|md|yml|yaml)$/.test(file)) {
  try {
    execFileSync('pnpm', ['exec', 'prettier', '--write', file], {
      cwd: process.env.CLAUDE_PROJECT_DIR,
      stdio: 'ignore',
    });
  } catch {
    // Non-blocking: lint/format:check will surface anything real.
  }
}
