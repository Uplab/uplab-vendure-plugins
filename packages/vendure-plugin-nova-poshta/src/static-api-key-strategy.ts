import type { NovaPoshtaApiKeyStrategy } from './types';

/**
 * @description
 * The strategy behind `NovaPoshtaPlugin.init({ apiKey: 'string' })`: one key for every request.
 */
export class StaticNovaPoshtaApiKeyStrategy implements NovaPoshtaApiKeyStrategy {
  constructor(private readonly apiKey: string) {}

  getApiKey(): string {
    return this.apiKey;
  }
}
