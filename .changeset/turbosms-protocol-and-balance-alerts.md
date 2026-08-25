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
  recovers, so a top-up followed by another drop is still reported. The interval only
  starts once the alert went out, so a callback that throws is retried next run. Backed by
  Vendure's `CacheService` and failing open. Omitted (or `0`), the behaviour is unchanged:
  an alert on every scheduled run while the balance is low.
- `onCheckFailed` — called when a scheduled check cannot read the balance at all. The task
  still rethrows, so the failed run is recorded either way; the callback is what turns "we
  no longer know the balance" into something that reaches a person.

The scheduled task also sets its own timeout when the configured request timeout plus 20 s
of callback headroom would not fit in `DefaultSchedulerPlugin`'s `defaultTimeout`, so a slow
API response is not reported as a task failure. When it fits, the scheduler's setting is left
as it was — as it is for a `defaultTimeout` given as a duration string, which only the
scheduler's own parser can read, with a warning so a short one is not left unnoticed.

`TurboSmsService.getBalance()` now throws a `TurboSmsTransportError` for a 2xx body without a
balance in it, instead of a bare `TypeError`, so the scheduled check reports it as an outage.
