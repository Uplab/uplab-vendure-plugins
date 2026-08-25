# @uplab/vendure-plugin-turbosms

Send transactional SMS from Vendure through [TurboSMS](https://turbosms.ua/), the Ukrainian
bulk-SMS provider.

The plugin adds no GraphQL API extensions, no entities and no admin UI. It exports one
injectable service, `TurboSmsService`, with `send()`, `sendBulk()` and `getBalance()`.

It is deliberately message-agnostic: it sends the text you hand it. Composing that text —
templates, translations, which language a given customer reads — stays in your
application, which knows its own copy. What the plugin does own is everything specific to
sending SMS through this provider: the wire format, phone number formatting, segment
accounting, per-recipient outcomes, and the account balance.

No runtime dependencies: the client is built on the global `fetch`.

Compatible with **Vendure ^3.7.0**.

## Install

```bash
npm install @uplab/vendure-plugin-turbosms
# or
pnpm add @uplab/vendure-plugin-turbosms
```

`@vendure/core` and `@nestjs/common` are peer dependencies — the plugin uses the copies
already in your project.

## Usage

```ts
import { VendureConfig } from '@vendure/core';
import { TurboSmsPlugin } from '@uplab/vendure-plugin-turbosms';

export const config: VendureConfig = {
  // ...
  plugins: [
    TurboSmsPlugin.init({
      apiKey: process.env.TURBOSMS_API_KEY!,
      sender: 'MyShop',
      dryRun: process.env.NODE_ENV !== 'production',
    }),
  ],
};
```

Then inject the service anywhere in your own plugin:

```ts
import { Injectable } from '@nestjs/common';
import { Logger } from '@vendure/core';
import { TurboSmsError, TurboSmsService } from '@uplab/vendure-plugin-turbosms';

@Injectable()
export class MyAuthService {
  constructor(private turboSms: TurboSmsService) {}

  async sendLoginCode(phone: string, code: string): Promise<boolean> {
    const text = `Your MyShop login code – ${code}`;

    try {
      await this.turboSms.send(phone, text);
      return true;
    } catch (e) {
      if (e instanceof TurboSmsError) {
        // Log it and fall back to another channel rather than failing the request.
        Logger.error(e.message, 'MyAuthService');
        return false;
      }
      throw e;
    }
  }
}
```

Remember to add `TurboSmsPlugin` to your own plugin's `imports` if you inject its service,
since Vendure plugins are Nest modules.

## Options

`TurboSmsPlugin.init(options)`:

| Option            | Type                       | Default                      | Description                                                                      |
| ----------------- | -------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `apiKey`          | `string`                   | _required_                   | The TurboSMS API key (the bearer token from your TurboSMS account).              |
| `sender`          | `string`                   | _required_                   | The registered alphanumeric sender name ("alpha name"). Overridable per call.    |
| `dryRun`          | `boolean`                  | `false`                      | When `true`, nothing is sent: the message is written to the Vendure log instead. |
| `apiUrl`          | `string`                   | `'https://api.turbosms.ua/'` | Base URL of the TurboSMS REST API. Point it at a mock server in tests.           |
| `timeout`         | `number`                   | `10000`                      | How long a request may take before it is aborted, in milliseconds.               |
| `lowBalanceAlert` | `{ threshold, schedule? }` | —                            | Registers a scheduled balance check. See **Watching the balance**.               |

## Sending

```ts
// One recipient.
const result = await turboSms.send('380501234567', 'Your code is 1234');

// The same text to many recipients, in a single request.
await turboSms.sendBulk(['380501234567', '380671234567'], 'We are closed on Monday');

// A different registered alpha name for this message only.
await turboSms.send('380501234567', 'Your code is 1234', { sender: 'MyOtherShop' });
```

Both return a `TurboSmsSendResult`:

```ts
{
  dryRun: boolean;        // true when the message was only logged
  recipients: string[];   // after normalization
  text: string;
  sender: string;
  accepted: string[];               // numbers TurboSMS took for delivery
  refused: TurboSmsRefusedRecipient[];  // { phone, responseCode, responseStatus }
  response?: TurboSmsSendMessageResponse;  // the raw API response; absent in dry-run mode
}
```

**A request can be accepted as a whole while an individual number is refused**, which is
easy to miss when reading only the top-level response code. That is why the result splits
recipients up front:

```ts
const { refused } = await turboSms.sendBulk(phones, text);
if (refused.length) {
  Logger.warn(`Not delivered: ${refused.map((r) => `${r.phone} (${r.responseStatus})`).join(', ')}`);
}
```

There is no message template or localization layer: the plugin sends the text you hand
it. See **Localizing messages** for how to keep that copy in your application.

## Phone numbers

TurboSMS wants digits only, no leading `+` — `380501234567`. Storefronts collect whatever
the customer typed, so every recipient is stripped down before it is sent:

1. Everything that is not a digit is dropped, `+` and separators included.
2. A leading `00` — the international access code, the written form of `+` — is dropped.

```ts
await turboSms.send('+38 (050) 123-45-67', text); // → 380501234567
await turboSms.send('00380501234567', text); //      → 380501234567
```

Both steps only remove notation. **The plugin never adds a country code**, because which
country a national number like `0501234567` belongs to is not something it can know — that
is a fact about your customers. Such a number goes out as stored and TurboSMS refuses it,
which shows up in `refused` rather than being silently guessed at.

So store phone numbers in international form. If you have national ones, expand them where
the country is known:

```ts
const international = phone.replace(/\D/g, '').replace(/^0/, '380');
await turboSms.send(international, text);
```

The stripping does not validate: a string that is not a phone number goes out as whatever
digits it contained, and TurboSMS refuses it per recipient.

## Message length and cost

TurboSMS bills per segment, and a segment is much smaller in Cyrillic than the familiar
160 characters: **one** non-Latin character re-encodes the whole message to UCS-2, where a
segment holds **70** characters instead of 160. A 75-character Ukrainian message therefore
costs two segments, and a message that mixes in a single `і` costs the same as one written
entirely in Ukrainian.

Worth knowing when writing campaign copy, or when showing an author how much room is left.

The plugin does not count segments for you — that is the GSM 03.38 standard rather than
anything specific to TurboSMS, and it is a solved problem: use a dedicated package such as
[`split-sms`](https://www.npmjs.com/package/split-sms) or
[`sms-segments-calculator`](https://www.npmjs.com/package/sms-segments-calculator) if you
need the exact count.

## Localizing messages

The plugin ships no templates on purpose: a published package cannot know your copy, and
Vendure's `I18nService` translates GraphQL error results for API responses, so it is not
available on the background paths that send SMS. Keep the strings in your application:

```ts
import { LanguageCode } from '@vendure/core';

const templates: Partial<Record<LanguageCode, { otpCode: (code: string) => string }>> = {
  [LanguageCode.en]: { otpCode: (code) => `Your MyShop login code – ${code}` },
  [LanguageCode.uk]: { otpCode: (code) => `Ваш код входу MyShop – ${code}` },
};

/** Falls back through the shop's default language to English. */
function template(languageCode: LanguageCode) {
  return templates[languageCode] ?? templates[defaultLanguageCode] ?? templates[LanguageCode.en]!;
}

const text = template(ctx.languageCode).otpCode(code);
await turboSms.send(phone, text);
```

If the recipient's number is a better signal of what they read than the storefront locale,
branch on it yourself — `recipient.startsWith('380') ? LanguageCode.uk : ctx.languageCode`.
That is a decision about your customers, not about TurboSMS, so it stays on your side.

## Events

The plugin publishes on Vendure's event bus, so metering and audit logging do not have to
wrap every call site:

| Event                     | When                                                                         |
| ------------------------- | ---------------------------------------------------------------------------- |
| `TurboSmsSentEvent`       | A send request was accepted. Carries the full result, `dryRun` sends too.    |
| `TurboSmsFailedEvent`     | A send request failed as a whole, published just before the error is thrown. |
| `TurboSmsLowBalanceEvent` | The scheduled balance check found the balance below the threshold.           |

```ts
eventBus.ofType(TurboSmsSentEvent).subscribe(({ result }) => {
  metrics.increment('sms.sent', result.accepted.length);
  metrics.increment('sms.refused', result.refused.length);
});
```

## Watching the balance

Running out of credit stops SMS silently from the application's point of view — the API
starts refusing sends. Configure `lowBalanceAlert` and the plugin registers a scheduled
task that checks the balance and warns before that happens:

```ts
TurboSmsPlugin.init({
  apiKey: process.env.TURBOSMS_API_KEY!,
  sender: 'MyShop',
  lowBalanceAlert: { threshold: 100 }, // UAH; checked daily at 09:00
});
```

`schedule` takes a cron expression or a `cron-time-generator` callback if the default does
not suit. The task logs a warning and publishes a `TurboSmsLowBalanceEvent`; subscribe to
that to raise an alert wherever your team watches. It is skipped in dry-run mode, and it
needs a scheduler plugin (such as Vendure's `DefaultSchedulerPlugin`) to be configured,
since that is what runs scheduled tasks.

`getBalance()` is there for a one-off check. It is a live call even in dry-run mode, where
the configured API key is usually a placeholder — guard it with `isDryRun`.

## GraphQL surface

None. The plugin contributes no schema extensions, resolvers, entities, permissions or
custom fields — it is a service-only plugin.

## Error handling

Everything the plugin throws extends `TurboSmsError`, so one `catch` covers falling back
to another channel. Both kinds carry the `endpoint` that failed.

| Error                    | When                                                                                         | Extra fields                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `TurboSmsRejectedError`  | TurboSMS answered, and the answer was a refusal — unknown alpha name, empty balance, …       | `responseCode`, `responseStatus`, `responseResult`, `recipientCodes`, `recipients`, `text` |
| `TurboSmsTransportError` | The request never produced a usable answer: network failure, timeout, non-2xx, non-JSON body | `status` (when there was an HTTP response), `cause`                                        |

Response codes `0`, `1` and `800`–`803` are treated as accepted; everything else raises a
`TurboSmsRejectedError`.

A `TurboSmsTransportError` means the outcome is **unknown** — the message may or may not
have gone out, so an automatic retry can deliver it twice.

The message body is never put into an error's `message`, so codes do not leak into logs
through a stack trace. It is available on `TurboSmsRejectedError.text` if you need it.

## Dry-run mode

With `dryRun: true`, nothing touches the network: the recipients and the message body are
written to the Vendure log under the `TurboSmsPlugin` context, and the call resolves with
`dryRun: true`. `TurboSmsService.isDryRun` exposes the flag, so monitoring code can skip
balance checks when there is no real account behind the plugin.

Because the body is logged verbatim, anything sensitive in it — a one-time code, an order
total — ends up in your logs. Dry run is a development mode; do not enable it in
production.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT © Uplab
