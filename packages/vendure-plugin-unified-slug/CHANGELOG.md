# @uplab/vendure-plugin-unified-slug

## 0.2.0

### Minor Changes

- [#22](https://github.com/Uplab/uplab-vendure-plugins/pull/22) [`a354e4d`](https://github.com/Uplab/uplab-vendure-plugins/commit/a354e4dd564bc830241ae5e609e1c72631019887) Thanks [@brmk](https://github.com/brmk)! - Add `backfillUnifiedSlugs(config, { dryRun })`, a function to run once from a host script. It brings products and collections saved before the plugin onto one slug per entity. It boots Vendure headless from your config, applies the same rule as the interceptor in one transaction, works on every database Vendure supports, and prints a report of what was (or, with `dryRun`, would be) filled, rewritten, generated, or left alone because of a conflict. It replaces the PostgreSQL queries previously shown in the README.

## 0.1.0

### Minor Changes

- [#21](https://github.com/Uplab/uplab-vendure-plugins/pull/21) [`01444f5`](https://github.com/Uplab/uplab-vendure-plugins/commit/01444f5d6fd4856b2460ef9fc4db4a49c67e2d80) Thanks [@brmk](https://github.com/brmk)! - Initial release. Keeps one slug per product and collection, identical in every language: a server-side interceptor unifies the slugs of every create and update before core saves them, and the React dashboard shows a single slug field that also generates the slug on update — the stock field leaves a language added to an existing entity with an empty slug. What a generated slug says is pluggable through `UnifiedSlugStrategy`; `SlugGenerationService` and the `unifiedSlugGenerate` Admin API query expose it to importers and other plugins.
