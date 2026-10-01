import path from 'path';
import { Injector, LanguageCode, mergeConfig, type RequestContext } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import gql from 'graphql-tag';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnifiedSlugPlugin, type UnifiedSlugBaseInput, type UnifiedSlugStrategy } from '../src';
import { initialData } from './fixtures/initial-data';
import {
  CREATE_PRODUCT,
  slugsByLanguage,
  type TranslationRow,
  UNIFIED_SLUG_GENERATE,
  UNIFIED_SLUG_SETTINGS,
} from './graphql';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__sqlite-data__')));

/** Appends a watched form value to product slugs: "summer-dress-milky". */
class SuffixSlugStrategy implements UnifiedSlugStrategy {
  readonly watchFormFields = ['customFields.colour'];
  injector: Injector | undefined;

  init(injector: Injector) {
    this.injector = injector;
  }

  generateBase(_ctx: RequestContext, { entityName, name, context }: UnifiedSlugBaseInput): string {
    const colour = context['customFields.colour'];
    return entityName === 'Product' && typeof colour === 'string' && colour ? `${name} ${colour}` : name;
  }
}

const CREATE_CHANNEL = gql`
  mutation CreateChannel($input: CreateChannelInput!) {
    createChannel(input: $input) {
      ... on Channel {
        id
        token
      }
    }
  }
`;

const UPDATE_GLOBAL_LANGUAGES = gql`
  mutation UpdateGlobalLanguages($languages: [LanguageCode!]!) {
    updateGlobalSettings(input: { availableLanguages: $languages }) {
      ... on GlobalSettings {
        availableLanguages
      }
    }
  }
`;

const ACTIVE_CHANNEL_ZONES = gql`
  query ActiveChannelZones {
    activeChannel {
      defaultShippingZone {
        id
      }
      defaultTaxZone {
        id
      }
    }
  }
`;

interface ActiveChannelZones {
  activeChannel: { defaultShippingZone: { id: string }; defaultTaxZone: { id: string } };
}

describe('UnifiedSlugPlugin with a custom strategy', () => {
  const strategy = new SuffixSlugStrategy();
  const { server, adminClient } = createTestEnvironment(
    mergeConfig(testConfig, {
      // Its own port: vitest runs every e2e file of the repo in parallel.
      apiOptions: { port: 3053 },
      plugins: [UnifiedSlugPlugin.init({ slugStrategy: strategy })],
    }),
  );

  beforeAll(async () => {
    await server.init({ initialData, customerCount: 0 });
    await adminClient.asSuperAdmin();
  }, 120_000);

  afterAll(async () => {
    await server.destroy();
  });

  it('starts the strategy with an injector', () => {
    expect(strategy.injector).toBeInstanceOf(Injector);
  });

  it('builds the slug from the context the dashboard forwards', async () => {
    const { unifiedSlugGenerate } = await adminClient.query<{ unifiedSlugGenerate: string }>(UNIFIED_SLUG_GENERATE, {
      input: { entityName: 'Product', name: 'Summer Dress', context: { 'customFields.colour': 'Milky' } },
    });

    expect(unifiedSlugGenerate).toBe('summer-dress-milky');
  });

  it('tells the dashboard which form fields to forward', async () => {
    const { unifiedSlugSettings } = await adminClient.query<{ unifiedSlugSettings: { watchFormFields: string[] } }>(
      UNIFIED_SLUG_SETTINGS,
    );

    expect(unifiedSlugSettings.watchFormFields).toEqual(['customFields.colour']);
  });

  it('prefers the default language of the channel the request runs in', async () => {
    // A channel can only default to a language that is enabled globally.
    await adminClient.query(UPDATE_GLOBAL_LANGUAGES, { languages: [LanguageCode.en, LanguageCode.uk] });
    const { activeChannel } = await adminClient.query<ActiveChannelZones>(ACTIVE_CHANNEL_ZONES);
    const { createChannel } = await adminClient.query<{ createChannel: { id: string; token: string } }>(
      CREATE_CHANNEL,
      {
        input: {
          code: 'uk-channel',
          token: 'uk-channel-token',
          defaultLanguageCode: LanguageCode.uk,
          availableLanguageCodes: [LanguageCode.uk, LanguageCode.en],
          currencyCode: 'UAH',
          pricesIncludeTax: true,
          defaultShippingZoneId: activeChannel.defaultShippingZone.id,
          defaultTaxZoneId: activeChannel.defaultTaxZone.id,
        },
      },
    );
    adminClient.setChannelToken(createChannel.token);

    try {
      const { createProduct } = await adminClient.query<{ createProduct: { translations: TranslationRow[] } }>(
        CREATE_PRODUCT,
        {
          input: {
            translations: [
              { languageCode: 'en', name: 'Scarf', slug: 'scarf', description: '' },
              { languageCode: 'uk', name: 'Шарф', slug: 'sharf', description: '' },
            ],
          },
        },
      );

      expect(slugsByLanguage(createProduct.translations)).toEqual({ en: 'sharf', uk: 'sharf' });
    } finally {
      adminClient.setChannelToken('e2e-default-channel');
    }
  });
});
