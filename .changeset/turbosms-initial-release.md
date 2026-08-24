---
'@uplab/vendure-plugin-turbosms': minor
---

Initial release: send transactional SMS through TurboSMS.

- `TurboSmsPlugin.init({ apiKey, sender, dryRun?, apiUrl?, defaultLanguageCode?, translations? })`
- Exports `SmsService` (localized OTP messages) and `TurboSmsApiService` (typed TurboSMS client with `sendMessage()` and `getBalance()`)
- Built-in `en` / `uk` / `pl` message templates, overridable per language
- `dryRun` mode logs the message instead of calling the API
