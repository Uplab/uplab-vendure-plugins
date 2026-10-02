import 'dotenv/config';
import path from 'path';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { DefaultJobQueuePlugin, DefaultSchedulerPlugin, DefaultSearchPlugin, type VendureConfig } from '@vendure/core';
import { NovaPoshtaPlugin } from '@uplab/vendure-plugin-nova-poshta';
import { TurboSmsPlugin } from '@uplab/vendure-plugin-turbosms';
// Imported from source, not by package name: the dashboard's plugin discovery does not follow a pnpm
// workspace symlink into a package, so a plugin that ships a dashboard extension would be registered
// on the server but never compiled into the dashboard. The dashboard loads a compiled copy of these
// sources from node_modules/.cache, where only this package's own dependencies resolve — hence the
// plugin's peers (@nestjs/*, graphql-tag) in this package's devDependencies.
import { UnifiedSlugPlugin } from '../../vendure-plugin-unified-slug/src';

const port = +(process.env.APP_PORT ?? 3000);

/**
 * The dev server registers every plugin in this repo, so that `pnpm dev` is enough to
 * smoke-test any of them. Each plugin defaults to its dry-run / stub mode; fill in
 * `.env` (see `.env.example`) to talk to the real vendor API.
 */
export const config: VendureConfig = {
  apiOptions: {
    port,
    adminApiPath: 'admin-api',
    shopApiPath: 'shop-api',
    adminApiPlayground: { settings: { 'request.credentials': 'include' } },
    adminApiDebug: true,
    shopApiPlayground: { settings: { 'request.credentials': 'include' } },
    shopApiDebug: true,
    cors: {
      // Any localhost port: the dashboard dev server moves off 5173 when that port is taken (PORT=…).
      origin: [/^http:\/\/localhost:\d+$/],
      credentials: true,
    },
  },
  authOptions: {
    tokenMethod: ['bearer', 'cookie'],
    superadminCredentials: {
      identifier: 'superadmin',
      password: 'superadmin',
    },
    cookieOptions: {
      secret: 'dev-server-cookie-secret',
    },
  },
  dbConnectionOptions: {
    type: 'better-sqlite3',
    synchronize: true,
    logging: false,
    database: path.join(__dirname, '../vendure.sqlite'),
  },
  paymentOptions: {
    paymentMethodHandlers: [],
  },
  plugins: [
    AssetServerPlugin.init({
      route: 'assets',
      assetUploadDir: path.join(__dirname, '../static/assets'),
    }),
    DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
    DefaultSchedulerPlugin.init({}),
    DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),

    // --- plugins under development ---
    TurboSmsPlugin.init({
      apiKey: process.env.TURBOSMS_API_KEY ?? 'dev-api-key',
      sender: process.env.TURBOSMS_SENDER ?? 'Vendure',
      dryRun: process.env.TURBOSMS_DRY_RUN !== 'false',
    }),
    UnifiedSlugPlugin.init(),
    // With the placeholder key the Shop queries fail with Nova Poshta's "API key incorrect".
    NovaPoshtaPlugin.init({ apiKey: process.env.NOVA_POSHTA_API_KEY ?? 'dev-api-key' }),
  ],
};
