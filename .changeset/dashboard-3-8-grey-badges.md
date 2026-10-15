---
'@uplab/vendure-plugin-change-history': patch
'@uplab/vendure-plugin-exchange-rates': patch
---

Keep the grey badges grey on the Vendure 3.8 dashboard. Its Badge no longer has a `secondary` variant and shows such a badge as plain text. That hit the «System change» badge in the change history, and the «Disabled» and «Fetched rate» badges on the exchange-rate pages. They look the same as before on 3.7.
