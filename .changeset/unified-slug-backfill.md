---
'@uplab/vendure-plugin-unified-slug': minor
---

Add `backfillUnifiedSlugs(config, { dryRun })`, a function to run once from a host script. It brings products and collections saved before the plugin onto one slug per entity. It boots Vendure headless from your config, applies the same rule as the interceptor in one transaction, works on every database Vendure supports, and prints a report of what was (or, with `dryRun`, would be) filled, rewritten, generated, or left alone because of a conflict. It replaces the PostgreSQL queries previously shown in the README.
