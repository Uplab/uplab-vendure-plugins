import { bootstrap, JobQueueService, Logger } from '@vendure/core';
import { config } from './vendure-config';

bootstrap(config)
  .then((app) => app.get(JobQueueService).start())
  .catch((err) => {
    Logger.error(String(err), 'dev-server', err instanceof Error ? err.stack : undefined);
    process.exit(1);
  });
