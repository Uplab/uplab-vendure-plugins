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
      // Every source file, dashboard components (`.tsx`) included — measured whether or not a test loads them.
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        'packages/dev-server/**',
        '**/*.spec.{ts,tsx}',
        '**/dist/**',
        // The render tests' stand-ins for @vendure/dashboard and Lingui: test code, not shipped.
        '**/src/dashboard/testing/**',
        // Dashboard GraphQL documents only run in the browser, parsed by the dashboard itself.
        '**/src/dashboard/graphql.ts',
      ],
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
