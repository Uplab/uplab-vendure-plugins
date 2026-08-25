---
'@uplab/vendure-plugin-turbosms': minor
---

Initial release: send transactional SMS through TurboSMS.

- `TurboSmsPlugin.init({ apiKey, sender, dryRun?, apiUrl?, timeout?, lowBalanceAlert? })`
- Exports `TurboSmsService` — `send()`, `sendBulk()` and `getBalance()`, plus an `isDryRun` flag
- Recipients are stripped to the digits TurboSMS expects (separators, `+`, a leading `00`); no country code is ever added
- Send results split recipients into `accepted` and `refused`, so a number refused inside an accepted request is not missed
- `lowBalanceAlert` warns before the account runs dry: an `onLowBalance` callback fires the moment TurboSMS refuses a send for insufficient funds, and — when a `threshold` is set — from a scheduled balance check as well
- Publishes `TurboSmsSentEvent` / `TurboSmsFailedEvent`, and `TurboSmsLowBalanceEvent` from the scheduled balance check
- Failures are `TurboSmsError`: `TurboSmsRejectedError` when TurboSMS refuses a request (carrying the per-recipient codes), `TurboSmsTransportError` when it fails or times out
- `dryRun` mode logs the message instead of calling the API
- No runtime dependencies — the client is built on the global `fetch`
