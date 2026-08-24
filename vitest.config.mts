import { defineConfig } from 'vitest/config';

/**
 * Root config: every `packages/vendure-plugin-*` with a vitest config runs as a project,
 * so a single `vitest run --coverage` produces one merged coverage report for the repo.
 * Coverage is a root-only option when projects are used.
 */
export default defineConfig({
  test: {
    projects: ['packages/vendure-plugin-*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/dev-server/**', '**/*.spec.ts', '**/dist/**'],
      reporter: ['text-summary', 'lcov', 'json-summary'],
      // Enforced locally and in CI; Codecov only reports. Raise as coverage grows.
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 80,
      },
    },
  },
});
