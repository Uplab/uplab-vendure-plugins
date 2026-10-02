---
'@uplab/vendure-plugin-unified-slug': minor
---

Initial release. Keeps one slug per product and collection, identical in every language: a server-side interceptor unifies the slugs of every create and update before core saves them, and the React dashboard shows a single slug field that also generates the slug on update — the stock field leaves a language added to an existing entity with an empty slug. What a generated slug says is pluggable through `UnifiedSlugStrategy`; `SlugGenerationService` and the `unifiedSlugGenerate` Admin API query expose it to importers and other plugins.
