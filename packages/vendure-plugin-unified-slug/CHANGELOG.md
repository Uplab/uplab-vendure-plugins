# @uplab/vendure-plugin-unified-slug

## 0.2.2

### Patch Changes

- [#43](https://github.com/Uplab/uplab-vendure-plugins/pull/43) [`c7d7775`](https://github.com/Uplab/uplab-vendure-plugins/commit/c7d777541307cf7be3a80b07f9e3438e9c03c2f1) Thanks [@brmk](https://github.com/brmk)! - Install alongside Vendure 3.8: the `@nestjs/common` and `@nestjs/core` peers now accept `^11 || ^12`, and `@nestjs/graphql` accepts `^13 || ^14`. Vendure 3.8 moved to NestJS 12, so `npm install` failed with `ERESOLVE` against the old `^11` / `^13` ranges. Nothing changes on Vendure 3.7.

## 0.2.1

### Patch Changes

- [#41](https://github.com/Uplab/uplab-vendure-plugins/pull/41) [`31d5deb`](https://github.com/Uplab/uplab-vendure-plugins/commit/31d5deba10edce2aef108da53358fafbb5ff7fae) Thanks [@brmk](https://github.com/brmk)! - Ship the LICENSE file in the package.

## 0.2.0

### Minor Changes

- [#22](https://github.com/Uplab/uplab-vendure-plugins/pull/22) [`a354e4d`](https://github.com/Uplab/uplab-vendure-plugins/commit/a354e4dd564bc830241ae5e609e1c72631019887) Thanks [@brmk](https://github.com/brmk)! - Add `backfillUnifiedSlugs(config, { dryRun })`, a function to run once from a host script. It brings products and collections saved before the plugin onto one slug per entity. It boots Vendure headless from your config, applies the same rule as the interceptor in one transaction, works on every database Vendure supports, and prints a report of what was (or, with `dryRun`, would be) filled, rewritten, generated, or left alone because of a conflict. It replaces the PostgreSQL queries previously shown in the README.

## 0.1.0

### Minor Changes

- [#21](https://github.com/Uplab/uplab-vendure-plugins/pull/21) [`01444f5`](https://github.com/Uplab/uplab-vendure-plugins/commit/01444f5d6fd4856b2460ef9fc4db4a49c67e2d80) Thanks [@brmk](https://github.com/brmk)! - Initial release. Keeps one slug per product and collection, identical in every language: a server-side interceptor unifies the slugs of every create and update before core saves them, and the React dashboard shows a single slug field that also generates the slug on update — the stock field leaves a language added to an existing entity with an empty slug. What a generated slug says is pluggable through `UnifiedSlugStrategy`; `SlugGenerationService` and the `unifiedSlugGenerate` Admin API query expose it to importers and other plugins.
