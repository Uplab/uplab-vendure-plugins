---
'@uplab/vendure-plugin-exchange-rates': patch
---

Rows from before the `baseCurrency` column are now also adopted when MySQL filled the column with `''`, and until they are, the Admin API lists them with the base they will get instead of failing the whole list on a null.

An adoption publishes a `synced` event; to see the one on boot, subscribe in `onModuleInit` (the README example now does).

The worker adopts such rows on bootstrap too, so it no longer depends on the server booting first, and the boot backfill no longer throws on a database error.
