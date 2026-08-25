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

| Option            | Type                                                                                  | Default                      | Description                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `apiKey`          | `string`                                                                              | _required_                   | The TurboSMS API key (the bearer token from your TurboSMS account).                         |
| `sender`          | `string`                                                                              | _required_                   | The registered alphanumeric sender name ("alpha name"). Overridable per call.               |
| `dryRun`          | `boolean`                                                                             | `false`                      | When `true`, nothing is sent: the message is written to the Vendure log instead.            |
| `apiUrl`          | `string`                                                                              | `'https://api.turbosms.ua/'` | Base URL of the TurboSMS REST API. Point it at a mock server in tests.                      |
| `timeout`         | `number`                                                                              | `10000`                      | How long a request may take before it is aborted, in milliseconds.                          |
| `lowBalanceAlert` | `{ threshold?, schedule?, onLowBalance?, minIntervalBetweenAlerts?, onCheckFailed? }` | —                            | Low-balance alerting: a callback, a scheduled check, or both. See **Watching the balance**. |

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

The same stripping is exported as `normalizePhoneNumber`, so an application that needs to
reason about a number before sending — picking a language from the country code, say — can
apply it rather than re-deriving it:

```ts
import { normalizePhoneNumber } from '@uplab/vendure-plugin-turbosms';

const digits = normalizePhoneNumber(phoneNumber); // '+38 (050) …' → '380501234567'
const lang = digits.startsWith('380') ? 'uk' : sessionLanguage;
```

So store phone numbers in international form. If you have national ones, expand them where
the country is known:

```ts
const international = normalizePhoneNumber(phone).replace(/^0/, '380');
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

| Event                     | When                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `TurboSmsSentEvent`       | A send request was accepted. Carries the full result, `dryRun` sends too.                        |
| `TurboSmsFailedEvent`     | A send request failed as a whole, published just before the error is thrown.                     |
| `TurboSmsLowBalanceEvent` | The **scheduled** check found the balance below the threshold. Not published for a refused send. |

```ts
eventBus.ofType(TurboSmsSentEvent).subscribe(({ result }) => {
  metrics.increment('sms.sent', result.accepted.length);
  metrics.increment('sms.refused', result.refused.length);
});
```

## Watching the balance

Running out of credit stops SMS silently from the application's point of view: the API
simply starts refusing sends. There are two triggers, and both call the same
`onLowBalance` callback, so you wire up notification once.

| Trigger             | When it fires                                             | Needs                     |
| ------------------- | --------------------------------------------------------- | ------------------------- |
| **Refused send**    | TurboSMS rejects a send for insufficient funds (code 103) | nothing                   |
| **Scheduled check** | The polled balance is below `threshold`                   | `threshold` + a scheduler |

The refused send is exact and immediate, costs no extra API call and works without a
scheduler — but by then messages are already failing. The scheduled check is what warns you
_before_ that happens. Configure both in production.

A third thing can happen: the scheduled check fails and the balance is simply unknown. That
is `onCheckFailed` — see **When the check itself fails**.

### The callback

```ts
TurboSmsPlugin.init({
  apiKey: process.env.TURBOSMS_API_KEY!,
  sender: 'MyShop',
  lowBalanceAlert: {
    onLowBalance: ({ message }) => notifySlack(message),
  },
});
```

`message` is the same line the plugin logs, so the simple case needs no unpacking. Add a
`threshold` to also poll the balance ahead of time:

```ts
lowBalanceAlert: {
  threshold: 100, // UAH; checked daily at 09:00
  onLowBalance: ({ message }) => notifySlack(message),
},
```

### Reaching your own services

The callback is handed Vendure's `Injector`, so it can use anything in the application
without you building a plugin to hold a subscription:

```ts
lowBalanceAlert: {
  threshold: 100,
  onLowBalance: async (context) => {
    const notifier = context.injector.get(MyNotifierService);

    switch (context.reason) {
      case 'scheduledCheck':
        // `balance` and `threshold` are numbers here.
        return notifier.warn(`TurboSMS balance is down to ${context.balance} UAH`);
      case 'sendRejected':
        // `error` carries the recipients and the response code.
        return notifier.page(`TurboSMS is out of credit: ${context.error.responseStatus}`);
    }
  },
},
```

Rules worth knowing:

- **Errors are caught and logged.** A failing callback never breaks a send or fails a
  scheduled run.
- **It is awaited**, so keep it quick — a slow callback delays the send's rejection and
  counts against the scheduled task's timeout. Queue anything slow.
- **It can fire once per refused send**, so a burst of failures means a burst of calls.
  Debounce before paging anyone.
- In a cluster the refused-send trigger fires on whichever instance sent the SMS, while the
  scheduled check runs once.
- **Dry-run fires neither trigger** — nothing reaches the API and the scheduled task skips
  itself — so a local test of `onLowBalance` will look like nothing happened.

### How often it repeats

While the balance stays low, every scheduled run alerts. That is the right default for a
single alert channel that collapses duplicates, and the wrong one for a chat room. Set
`minIntervalBetweenAlerts` to quieten it:

```ts
lowBalanceAlert: {
  threshold: 100,
  schedule: '0 * * * *',                    // check hourly
  minIntervalBetweenAlerts: 24 * 60 * 60 * 1000,  // but alert at most daily
  onLowBalance: ({ message }) => notifySlack(message),
},
```

**A recovery re-arms the alert immediately.** Topped up at noon and drained again by
evening, and you are told — a plain "once per day" timer would swallow that, and only the
check itself can tell the difference, because your callback never sees the healthy runs.

State lives in Vendure's `CacheService`, so it is as durable as your cache strategy: Redis
or DB survives restarts and is shared between instances, the default in-memory strategy
resets on restart. Cache failures fail open — a duplicate alert beats a silently dropped
one. Changing `threshold` re-arms too, since it is part of the key.

The interval gates the scheduled check only, `TurboSmsLowBalanceEvent` included. A refused
send always calls `onLowBalance`: its rate is bounded by your own send volume, and each one
is a customer message that actually failed.

### When the check itself fails

TurboSMS being unreachable is not a low balance — it means you no longer know what the
balance is. The task rethrows, so the run is recorded as failed, but nothing is pushed
anywhere unless you ask for it:

```ts
lowBalanceAlert: {
  threshold: 100,
  onLowBalance: ({ message }) => notifySlack(message),
  onCheckFailed: ({ message }) => notifySlack(message),  // "balance monitoring is blind"
},
```

`onCheckFailed` fires for a `TurboSmsError` — a refusal or a transport failure. Anything
else is a bug rather than an outage and is rethrown untouched. It shares
`minIntervalBetweenAlerts` under its own key, and re-arms as soon as a check succeeds.

Without it, a multi-day outage shows up only as failed runs in the scheduled-tasks screen —
which is exactly where nobody is looking while SMS still appears to work.

### Choosing when to check

`schedule` takes a cron expression or a `cron-time-generator` callback, and is only used
when a `threshold` is set:

```ts
lowBalanceAlert: { threshold: 100, schedule: '0 * * * *' }; // hourly
lowBalanceAlert: { threshold: 100, schedule: '0 9,18 * * 1-5' }; // 09:00 and 18:00 on weekdays
lowBalanceAlert: { threshold: 100, schedule: (cronTime) => cronTime.every(6).hours() };
```

The scheduled check needs a scheduler plugin (such as Vendure's `DefaultSchedulerPlugin`)
configured, since that is what runs scheduled tasks.

### Opting out

Omit `lowBalanceAlert` and nothing happens: no task is registered, no callback runs,
nothing extra is logged. There is deliberately no `enabled` flag — Vendure's own task
config has none either, and one more boolean would just be a second way to express "leave
it out".

To pause only the scheduled check at runtime without redeploying, disable it like any other
Vendure task — in the admin UI's scheduled-tasks screen, or on the Admin API:

```graphql
mutation {
  updateScheduledTask(input: { id: "turbosms-low-balance", enabled: false }) {
    id
    enabled
  }
}
```

That does not affect the refused-send trigger, which is not a scheduled task.

### The event-bus escape hatch

If you already have event subscribers, the scheduled check also publishes
`TurboSmsLowBalanceEvent`. A refused send publishes **no** low-balance event — there is no
balance figure to report — but it does publish `TurboSmsFailedEvent`, so the same case is
one predicate away:

```ts
eventBus.ofType(TurboSmsFailedEvent).subscribe(({ error }) => {
  if (error instanceof TurboSmsRejectedError && error.responseCode === INSUFFICIENT_FUNDS_RESPONSE_CODE) {
    // Out of credit.
  }
});
```

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

Code `103` (`NOT_ENOUGH_MONEY`) means the account is out of credit. It is exported as
`INSUFFICIENT_FUNDS_RESPONSE_CODE`, and it is what triggers `lowBalanceAlert.onLowBalance`
with `reason: 'sendRejected'` — see **Watching the balance**.

### Per-recipient codes

A refusal also carries a row per recipient. `recipientCodes` reads their codes in order, and
is empty when the rejection was request-level rather than per-number:

```ts
import {
  RECIPIENT_COUNTRY_NOT_ALLOWED_CODE,
  RECIPIENT_INSUFFICIENT_FUNDS_CODE,
  TurboSmsRejectedError,
} from '@uplab/vendure-plugin-turbosms';

catch (e) {
  if (e instanceof TurboSmsRejectedError) {
    const codes = e.recipientCodes;
    // Routine: SMS is not enabled for that country, fall back to another channel.
    if (codes.every((c) => c === RECIPIENT_COUNTRY_NOT_ALLOWED_CODE)) return callInstead();
    // Never routine: the account is empty and no recipient will go through.
    if (codes.includes(RECIPIENT_INSUFFICIENT_FUNDS_CODE)) return alertOps();
  }
}
```

A `TurboSmsTransportError` means the outcome is **unknown** — the message may or may not
have gone out, so an automatic retry can deliver it twice.

The message body is never put into an error's `message`, so codes do not leak into logs
through a stack trace. It is available on `TurboSmsRejectedError.text` if you need it.

`text` is an own enumerable property, though, so **serializing the whole error puts the body
back in** — `JSON.stringify(error)` in an alert or a log line will carry whatever the message
said, one-time codes included. Pick the fields you want, or redact `text`.

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
