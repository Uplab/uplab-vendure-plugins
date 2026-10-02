import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'e2e/**/*.e2e-spec.ts'],
    watch: false,
    // Booting a Vendure test server (and generating the sql.js fixture on first run)
    // is well over vitest's default 5s.
    testTimeout: process.env.E2E_DEBUG ? 1800_000 : 60_000,
    hookTimeout: process.env.E2E_DEBUG ? 1800_000 : 120_000,
    server: {
      deps: {
        // Avoids the "realm" graphql error, see
        // https://github.com/vitejs/vite/issues/7879#issuecomment-1349079757
        fallbackCJS: true,
      },
    },
  },
  // https://github.com/graphql/graphql-js/issues/2801#issuecomment-1846206543
  resolve: {
    alias: {
      graphql: 'graphql/index.js',
    },
  },
  plugins: [
    // SWC is required for the decorators used by Vendure plugins, see
    // https://github.com/vitest-dev/vitest/issues/708#issuecomment-1118628479
    swc.vite({
      jsc: {
        transform: {
          // https://github.com/vendure-ecommerce/vendure/issues/2099
          useDefineForClassFields: false,
        },
      },
    }),
  ],
});
