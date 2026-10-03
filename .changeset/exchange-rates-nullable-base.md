---
'@uplab/vendure-plugin-exchange-rates': patch
---

The `baseCurrency` column is nullable, so a generated migration adds it to a table that already has rows without hand edits. On boot (and in every sync) rows without a base are given the current one and keep their custom rates.
