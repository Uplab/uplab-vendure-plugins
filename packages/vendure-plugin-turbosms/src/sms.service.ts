import { Inject, Injectable } from '@nestjs/common';
import { LanguageCode, Logger, type RequestContext } from '@vendure/core';
import { TurboSmsError } from './classes';
import { loggerCtx, TURBOSMS_PLUGIN_OPTIONS } from './constants';
import { defaultTranslations, interpolate } from './i18n';
import { defaultResolveLanguage } from './language';
import { TurboSmsApiService } from './turbo-sms-api.service';
import { type ResolvedTurboSmsPluginOptions, type TurboSmsTranslations } from './types';

export interface SendOtpCodeResult {
  isCodeSent: boolean;
  error?: TurboSmsError;
}

/**
 * @description
 * The higher-level SMS service: it renders a localized message and hands it to
 * {@link TurboSmsApiService}. Exported by the {@link TurboSmsPlugin}.
 */
@Injectable()
export class SmsService {
  constructor(
    private turboSmsApiService: TurboSmsApiService,
    @Inject(TURBOSMS_PLUGIN_OPTIONS)
    private options: ResolvedTurboSmsPluginOptions,
  ) {}

  /**
   * @description
   * Sends a one-time-password message to `recipient` (international format, no leading
   * `+`, e.g. `380501234567`).
   *
   * The language is chosen by {@link SmsService.resolveLanguage}. Errors are logged and
   * returned rather than thrown, so a caller can fall back to another channel.
   */
  async sendOtpCode(ctx: RequestContext, recipient: string, code: string): Promise<SendOtpCodeResult> {
    const languageCode = this.resolveLanguage(ctx, recipient);
    const message = interpolate(this.template(languageCode).otpCode, {
      code,
      sender: this.options.sender,
    });

    try {
      await this.turboSmsApiService.sendMessage([recipient], message);
    } catch (e) {
      if (e instanceof TurboSmsError) {
        Logger.error(e.message, loggerCtx);
        return { isCodeSent: false, error: e };
      }
      throw e;
    }

    return { isCodeSent: true };
  }

  /**
   * @description
   * Decides which language a message to `recipient` is rendered in.
   *
   * The `resolveLanguage` plugin option wins outright when it is configured. Otherwise
   * the built-in rule applies: a recipient whose dialling prefix pins them to a language
   * (see `languageByDiallingPrefix`) gets that language, and everyone else gets the
   * language of the request context.
   */
  resolveLanguage(ctx: RequestContext, recipient: string): LanguageCode {
    if (this.options.resolveLanguage) {
      return this.options.resolveLanguage(recipient);
    }
    return defaultResolveLanguage(recipient) ?? ctx.languageCode;
  }

  /**
   * @description
   * Resolves the message templates for a language, falling back to the configured
   * default language and then to English.
   */
  template(languageCode: LanguageCode): TurboSmsTranslations {
    const overrides = this.options.translations ?? {};
    const candidates = [languageCode, this.options.defaultLanguageCode, LanguageCode.en];

    for (const candidate of candidates) {
      const merged = { ...defaultTranslations[candidate], ...overrides[candidate] };
      if (merged.otpCode) {
        return merged as TurboSmsTranslations;
      }
    }

    // Unreachable in practice: `defaultTranslations[LanguageCode.en]` always exists.
    return defaultTranslations[LanguageCode.en] as TurboSmsTranslations;
  }
}
