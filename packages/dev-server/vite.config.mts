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
      api: { host: apiHost, port: apiPort },
      gqlOutputPath: path.resolve(__dirname, './src/gql'),
    }),
  ],
});
