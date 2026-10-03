---
'@uplab/vendure-plugin-exchange-rates': patch
---

Rows from before the `baseCurrency` column are now adopted when MySQL filled the column with `''` too, and until they are, the Admin API lists them with the base they will get instead of failing the whole list on a null. An adoption counts as a change, so a `synced` event goes out — also on boot, which a subscriber only sees if it subscribes in `onModuleInit` (the README example now does), the worker adopts them on bootstrap as well (so its `getRate` does not wait for the next sync), and the boot backfill no longer throws on a database error.
