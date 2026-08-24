# @uplab/vendure-plugin-turbosms

Send transactional SMS from Vendure through [TurboSMS](https://turbosms.ua/), the Ukrainian
bulk-SMS provider.

The plugin adds no GraphQL API extensions, no entities and no admin UI. It exports two
injectable services that other plugins and the host application can use:

- **`SmsService`** — renders a localized message and sends it. Currently one message type:
  a one-time-password code.
- **`TurboSmsApiService`** — a thin typed client for the TurboSMS REST API
  (`sendMessage()`, `getBalance()`).

Compatible with **Vendure ^3.7.0**.

## Install

```bash
npm install @uplab/vendure-plugin-turbosms
# or
pnpm add @uplab/vendure-plugin-turbosms
```

`@vendure/core` is a peer dependency — the plugin uses the copy already in your project.

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

Then inject the services anywhere in your own plugin:

```ts
import { Injectable } from '@nestjs/common';
import { RequestContext } from '@vendure/core';
import { SmsService, TurboSmsApiService, TurboSmsError } from '@uplab/vendure-plugin-turbosms';

@Injectable()
export class MyAuthService {
  constructor(
    private smsService: SmsService,
    private turboSmsApiService: TurboSmsApiService,
  ) {}

  async sendCode(ctx: RequestContext, phone: string, code: string) {
    const { isCodeSent, error } = await this.smsService.sendOtpCode(ctx, phone, code);
    if (!isCodeSent) {
      // `error` is a TurboSmsError with the raw per-recipient response codes
      throw error;
    }
  }

  async lowBalance(): Promise<boolean> {
    if (this.turboSmsApiService.isDryRun) {
      return false;
    }
    return (await this.turboSmsApiService.getBalance()) < 100;
  }
}
```

Remember to add `TurboSmsPlugin` to your own plugin's `imports` if you inject its
services, since Vendure plugins are Nest modules.

## Options

`TurboSmsPlugin.init(options)`:

| Option                | Type                                                           | Default                      | Description                                                                                |
| --------------------- | -------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `apiKey`              | `string`                                                       | _required_                   | The TurboSMS API key (the bearer token from your TurboSMS account).                        |
| `sender`              | `string`                                                       | _required_                   | The registered alphanumeric sender name ("alpha name").                                    |
| `dryRun`              | `boolean`                                                      | `false`                      | When `true`, nothing is sent: the message is written to the Vendure log instead.           |
| `apiUrl`              | `string`                                                       | `'https://api.turbosms.ua/'` | Base URL of the TurboSMS REST API. Point it at a mock server in tests.                     |
| `defaultLanguageCode` | `LanguageCode`                                                 | `LanguageCode.en`            | Language used when no template exists for the request's language.                          |
| `resolveLanguage`     | `(recipient: string) => LanguageCode`                          | built-in rule (see below)    | Decides a recipient's language from their phone number alone, replacing the built-in rule. |
| `translations`        | `Partial<Record<LanguageCode, Partial<TurboSmsTranslations>>>` | `{}`                         | Overrides for the built-in message templates, merged over the defaults per language.       |

## Messages and localization

The plugin ships templates for `en`, `uk` and `pl`:

| Language | `otpCode`                              |
| -------- | -------------------------------------- |
| `en`     | `Your {sender} login code – {code}`    |
| `uk`     | `Ваш код входу {sender} – {code}`      |
| `pl`     | `Twój kod logowania {sender} – {code}` |

`{sender}` and `{code}` are interpolated; unknown placeholders are left as-is.

Language resolution for `sendOtpCode()` happens in two steps. First the language is
chosen — `SmsService.resolveLanguage(ctx, recipient)`:

1. If you configured `resolveLanguage`, it decides, full stop.
2. Otherwise the built-in rule applies: a recipient whose dialling prefix pins them to a
   language gets that language. Only `380` (Ukraine) is mapped, since a Ukrainian mobile
   number is a stronger signal about what its owner reads than the storefront's current
   locale. The mapping is exported as `languageByDiallingPrefix`.
3. Everyone else gets `ctx.languageCode`.

Then a template is looked up for that language, falling back to `defaultLanguageCode`
and finally to `en`.

Replace the rule when it does not fit your customers:

```ts
TurboSmsPlugin.init({
  apiKey: '...',
  sender: 'MyShop',
  // Route by country, ignoring the storefront locale entirely.
  resolveLanguage: (recipient) => (recipient.startsWith('48') ? LanguageCode.pl : LanguageCode.en),
});
```

Override or add a language:

```ts
TurboSmsPlugin.init({
  apiKey: '...',
  sender: 'MyShop',
  translations: {
    [LanguageCode.uk]: { otpCode: 'Код підтвердження: {code}' },
    [LanguageCode.de]: { otpCode: 'Ihr {sender} Anmeldecode – {code}' },
  },
});
```

The templates are plain data owned by the plugin, deliberately **not** registered with
Vendure's `I18nService`. That service translates GraphQL error results for API responses
and is not usable from the background paths that send SMS, so a published package cannot
rely on it being wired up. If you keep all your copy in one place, pass your own strings
through `translations`.

## GraphQL surface

None. The plugin contributes no schema extensions, resolvers, entities, permissions or
custom fields — it is a service-only plugin.

## Error handling

`TurboSmsApiService.sendMessage()` throws a `TurboSmsError` when TurboSMS rejects a
request. It carries `responseCode`, `responseStatus`, `responseResult`, `recipients`, and
a `recipientCodes` getter with the per-recipient codes.

`SmsService.sendOtpCode()` catches `TurboSmsError`, logs it, and returns
`{ isCodeSent: false, error }` so a caller can fall back to another channel. Any other
error is re-thrown.

Response codes `0`, `1` and `800`–`803` are treated as accepted; everything else raises.

## Dry-run mode

With `dryRun: true`, `sendMessage()` logs the recipients and the message body under the
`TurboSmsPlugin` logger context and returns `undefined` without touching the network.
`TurboSmsApiService.isDryRun` exposes the flag, so monitoring code can skip balance
checks when there is no real account behind the plugin.

## Migrating from an in-project SMS plugin

If you are moving off a locally vendored version of this plugin, the option names changed:

| Before                                                          | Now                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `SmsPlugin`                                                     | `TurboSmsPlugin`                                               |
| `brandName`                                                     | `sender`                                                       |
| `isDev`                                                         | `dryRun`                                                       |
| —                                                               | `apiUrl` (new, defaults to the TurboSMS production endpoint)   |
| —                                                               | `defaultLanguageCode`, `resolveLanguage`, `translations` (new) |
| `TurboSmsApiService.isDevMode`                                  | `TurboSmsApiService.isDryRun`                                  |
| `i18n` via `I18nService` + `i18next`, `{brandName}` placeholder | `translations` option, `{sender}` placeholder                  |

Service class names (`SmsService`, `TurboSmsApiService`) and the `sendOtpCode()` /
`sendMessage()` / `getBalance()` signatures are unchanged.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT © Uplab
