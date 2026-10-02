# @uplab/vendure-plugin-turbosms

## 0.2.1

### Patch Changes

- [#18](https://github.com/Uplab/uplab-vendure-plugins/pull/18) [`490e94e`](https://github.com/Uplab/uplab-vendure-plugins/commit/490e94eff16714ee087a42910daefc80fa60398e) Thanks [@brmk](https://github.com/brmk)! - Add a package icon and improve the README: badges, a table of contents, a trademark note, and an intro that no longer claims the plugin does segment accounting (it explicitly does not) or enumerates service methods that can drift from the code.

## 0.2.0

### Minor Changes

- [#16](https://github.com/Uplab/uplab-vendure-plugins/pull/16) [`136d49e`](https://github.com/Uplab/uplab-vendure-plugins/commit/136d49eb49dd48e7654eec1485634157ea2ece91) Thanks [@brmk](https://github.com/brmk)! - Export the protocol knowledge consumers were re-deriving, and make the scheduled balance
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

## 0.1.0

### Minor Changes

- [`dd0f7b1`](https://github.com/Uplab/uplab-vendure-plugins/commit/dd0f7b18e43644d8f36aaad92fc57b09bfe9a63e) Thanks [@brmk](https://github.com/brmk)! - Initial release: send transactional SMS through TurboSMS.

  - `TurboSmsPlugin.init({ apiKey, sender, dryRun?, apiUrl?, timeout?, lowBalanceAlert? })`
  - Exports `TurboSmsService` — `send()`, `sendBulk()` and `getBalance()`, plus an `isDryRun` flag
  - Recipients are stripped to the digits TurboSMS expects (separators, `+`, a leading `00`); no country code is ever added
  - Send results split recipients into `accepted` and `refused`, so a number refused inside an accepted request is not missed
  - `lowBalanceAlert` warns before the account runs dry: an `onLowBalance` callback fires the moment TurboSMS refuses a send for insufficient funds, and — when a `threshold` is set — from a scheduled balance check as well
  - Publishes `TurboSmsSentEvent` / `TurboSmsFailedEvent`, and `TurboSmsLowBalanceEvent` from the scheduled balance check
  - Exports `INSUFFICIENT_FUNDS_RESPONSE_CODE`, so a `TurboSmsFailedEvent` subscriber can recognise a refusal for insufficient funds without a magic number
  - Failures are `TurboSmsError`: `TurboSmsRejectedError` when TurboSMS refuses a request (carrying the per-recipient codes), `TurboSmsTransportError` when it fails or times out
  - `dryRun` mode logs the message instead of calling the API
  - No runtime dependencies — the client is built on the global `fetch`
