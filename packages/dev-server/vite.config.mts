import path from 'path';
import { pathToFileURL } from 'url';
import { vendureDashboardPlugin } from '@vendure/dashboard/vite';
import { defineConfig } from 'vite';

const apiHost = process.env.VITE_ADMIN_API_HOST ?? 'http://localhost';
const apiPort = Number(process.env.VITE_ADMIN_API_PORT ?? process.env.APP_PORT ?? 3000);

/**
 * Vite config for the React dashboard. `vendureDashboardPlugin` introspects the Vendure
 * config, finds every plugin that declares a `dashboard` entry point, and compiles those
 * extensions into the dashboard app — so any plugin in this repo gets its dashboard UI
 * here for free.
 */
export default defineConfig({
  base: '/dashboard/',
  server: {
    host: process.env.HOST ?? 'localhost',
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, './dist/dashboard'),
    emptyOutDir: true,
  },
  plugins: [
    vendureDashboardPlugin({
      vendureConfigPath: pathToFileURL('./src/vendure-config.ts'),
      vendureConfigExport: 'config',
      // The config imports plugins from their sibling packages' sources (see vendure-config.ts), so
      // the compiled copy has to keep paths relative to the repo root, not to this package —
      // otherwise those plugin files land outside the compile directory and are never scanned.
      pathAdapter: {
        sourceRoot: path.resolve(__dirname, '../..'),
        getCompiledConfigPath: ({ outputPath, configFileName }) =>
          path.join(outputPath, 'packages/dev-server/src', configFileName),
      },
      api: { host: apiHost, port: apiPort },
      gqlOutputPath: path.resolve(__dirname, './src/gql'),
    }),
  ],
});
