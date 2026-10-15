---
'@uplab/vendure-plugin-change-history': patch
'@uplab/vendure-plugin-exchange-rates': patch
'@uplab/vendure-plugin-nova-poshta': patch
'@uplab/vendure-plugin-turbosms': patch
'@uplab/vendure-plugin-unified-slug': patch
---

Install alongside Vendure 3.8: the `@nestjs/common` and `@nestjs/core` peers now accept `^11 || ^12`, and `@nestjs/graphql` accepts `^13 || ^14`. Vendure 3.8 moved to NestJS 12, so `npm install` failed with `ERESOLVE` against the old `^11` / `^13` ranges. Vendure 3.7 with NestJS 11 keeps working as before.

`engines.node` is now `^20.19.0 || >=22.12.0`: NestJS 12 ships only as ES modules, and these CommonJS builds load it through `require(esm)`, which Node has without a flag from those versions on (Vendure 3.8 needs them for the same reason). Node 20 before 20.19 and 22 before 22.12 now get an engines warning, also on Vendure 3.7.
