---
'@uplab/vendure-plugin-turbosms': minor
---

Export the protocol knowledge consumers were re-deriving, and make the scheduled balance
check survive contact with a real ops channel.

New exports:

- `normalizePhoneNumber` — the same stripping the plugin applies to every recipient. An
  application that reasons about a number before sending (picking a language from the
  country code, say) no longer has to reimplement it.
- `RECIPIENT_COUNTRY_NOT_ALLOWED_CODE` (406) and `RECIPIENT_INSUFFICIENT_FUNDS_CODE` (203)
  — the per-recipient codes a caller has to classify. Distinct from the request-level
  `INSUFFICIENT_FUNDS_RESPONSE_CODE` (103), which is a different row of the response.
- `TurboSmsRejectedError.recipientCodes` — the codes in order, empty for a request-level
  rejection.

New `lowBalanceAlert` options:

- `minIntervalBetweenAlerts` — stay quiet after alerting, but re-arm as soon as the balance
  recovers, so a top-up followed by another drop is still reported. Backed by Vendure's
  `CacheService` and failing open. Omitted, the behaviour is unchanged: an alert on every
  scheduled run while the balance is low.
- `onCheckFailed` — called when a scheduled check cannot read the balance at all. The task
  still rethrows, so the failed run is recorded either way; the callback is what turns "we
  no longer know the balance" into something that reaches a person.

The scheduled task also now sets its own timeout from the configured request timeout, rather
than riding the scheduler default, so a slow API response is not reported as a task failure.
