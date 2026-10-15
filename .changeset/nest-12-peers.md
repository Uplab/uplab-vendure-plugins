---
'@uplab/vendure-plugin-change-history': patch
'@uplab/vendure-plugin-exchange-rates': patch
'@uplab/vendure-plugin-nova-poshta': patch
'@uplab/vendure-plugin-turbosms': patch
'@uplab/vendure-plugin-unified-slug': patch
---

Install alongside Vendure 3.8: the `@nestjs/common` and `@nestjs/core` peers now accept `^11 || ^12`, and `@nestjs/graphql` accepts `^13 || ^14`. Vendure 3.8 moved to NestJS 12, so `npm install` failed with `ERESOLVE` against the old `^11` / `^13` ranges. Nothing changes on Vendure 3.7.
