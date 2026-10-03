# @uplab/vendure-plugin-exchange-rates

## 0.1.2

### Patch Changes

- [#33](https://github.com/Uplab/uplab-vendure-plugins/pull/33) [`c586872`](https://github.com/Uplab/uplab-vendure-plugins/commit/c586872710e16bdcccd1be7a45c614905d7c6a4b) Thanks [@brmk](https://github.com/brmk)! - Rows from before the `baseCurrency` column are now also adopted when MySQL filled the column with `''`, and until they are, the Admin API lists them with the base they will get instead of failing the whole list on a null.

  An adoption publishes a `synced` event; to see the one on boot, subscribe in `onModuleInit` (the README example now does).

  The worker adopts such rows on bootstrap too, so it no longer depends on the server booting first, and the boot backfill no longer throws on a database error.

## 0.1.1

### Patch Changes

- [#31](https://github.com/Uplab/uplab-vendure-plugins/pull/31) [`a1899fe`](https://github.com/Uplab/uplab-vendure-plugins/commit/a1899fe1422faec3f96b0f4259f713ab26b5deaf) Thanks [@brmk](https://github.com/brmk)! - The `baseCurrency` column is nullable, so a generated migration adds it to a table that already has rows without hand edits. On boot (and in every sync) rows without a base are given the current one and keep their custom rates.

## 0.1.0

### Minor Changes

- [#30](https://github.com/Uplab/uplab-vendure-plugins/pull/30) [`d132726`](https://github.com/Uplab/uplab-vendure-plugins/commit/d132726b2fecf429684ae6e558db6d9b754c03b2) Thanks [@brmk](https://github.com/brmk)! - Initial release: exchange rates in your shop's base currency from a pluggable source (the ECB, Frankfurter, Monobank, the NBU, fixed rates or your own), cross rates derived automatically, refreshed on a schedule, served on the Shop API and overridable per currency in the dashboard.
