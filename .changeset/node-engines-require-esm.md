---
'@uplab/vendure-plugin-change-history': patch
'@uplab/vendure-plugin-exchange-rates': patch
'@uplab/vendure-plugin-nova-poshta': patch
'@uplab/vendure-plugin-turbosms': patch
'@uplab/vendure-plugin-unified-slug': patch
---

`engines.node` is now `^20.19.0 || >=22.12.0`. NestJS 12 (Vendure 3.8) ships only as ES modules, and these CommonJS builds load it through `require(esm)`, which Node has without a flag from those versions on — Vendure 3.8 needs them for the same reason. An older Node now gets an engines warning at install instead of `ERR_REQUIRE_ESM` at boot; on Vendure 3.7 the warning shows too, nothing else changes.
