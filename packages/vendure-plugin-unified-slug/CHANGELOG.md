# @uplab/vendure-plugin-unified-slug

## 0.1.0

### Minor Changes

- [#21](https://github.com/Uplab/uplab-vendure-plugins/pull/21) [`01444f5`](https://github.com/Uplab/uplab-vendure-plugins/commit/01444f5d6fd4856b2460ef9fc4db4a49c67e2d80) Thanks [@brmk](https://github.com/brmk)! - Initial release. Keeps one slug per product and collection, identical in every language: a server-side interceptor unifies the slugs of every create and update before core saves them, and the React dashboard shows a single slug field that also generates the slug on update — the stock field leaves a language added to an existing entity with an empty slug. What a generated slug says is pluggable through `UnifiedSlugStrategy`; `SlugGenerationService` and the `unifiedSlugGenerate` Admin API query expose it to importers and other plugins.
