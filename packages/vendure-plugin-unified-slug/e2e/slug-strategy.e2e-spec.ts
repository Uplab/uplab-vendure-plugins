import path from 'path';
import { Injector, mergeConfig, type RequestContext } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnifiedSlugPlugin, type UnifiedSlugBaseInput, type UnifiedSlugStrategy } from '../src';
import { initialData } from './fixtures/initial-data';
import { UNIFIED_SLUG_GENERATE, UNIFIED_SLUG_SETTINGS } from './graphql';

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
});
