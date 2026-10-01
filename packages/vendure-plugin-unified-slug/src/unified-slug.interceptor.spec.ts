import { CallHandler, ExecutionContext } from '@nestjs/common';
import { ChannelService, ConfigService, LanguageCode, TransactionalConnection } from '@vendure/core';
import { Observable, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedSlugInterceptor } from './unified-slug.interceptor';

/**
 * The Nest plumbing, not the rule — `unify-slugs.spec.ts` owns the rule. What is asserted here is
 * exactly what an interceptor can get wrong: which fields it acts on, that everything else costs
 * nothing, and that the object the core resolver is about to read is the one that was changed.
 *
 * Hand-built rather than mocked away, so the interceptor is exercised through the same primitive it
 * uses in production (`GqlExecutionContext.create`). That Nest *calls* it for these mutations is
 * proven by the e2e spec.
 */
function makeExecutionContext(
  fieldName: string,
  input: unknown,
  alias?: string,
  req: object | undefined = { headers: { 'vendure-token': 'default-token' }, query: {} },
): ExecutionContext {
  // `fieldName` on a `GraphQLResolveInfo` is always the schema field; an alias only shows up in `path.key`.
  const info = { fieldName, path: { key: alias ?? fieldName } };
  const gqlArgs = [undefined, input === undefined ? {} : { input }, { req, res: {} }, info];
  const handler = function resolver() {
    return undefined;
  };
  const context = {
    getType: () => 'graphql',
    getArgs: () => gqlArgs,
    getArgByIndex: (index: number) => gqlArgs[index],
    getClass: () => class Resolver {},
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
  return context;
}

function makeInterceptor(
  existingRows: Array<{ languageCode: string; slug: string }> = [],
  getChannelFromToken = vi.fn(async (_token: string) => ({ defaultLanguageCode: LanguageCode.en })),
) {
  const getRawMany = vi.fn().mockResolvedValue(existingRows);
  const queryBuilder = {
    select: vi.fn().mockReturnThis(),
    addSelect: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    getRawMany,
  };
  const createQueryBuilder = vi.fn(() => queryBuilder);
  const connection = {
    rawConnection: { getRepository: vi.fn(() => ({ createQueryBuilder })) },
  } as unknown as TransactionalConnection;
  const channelService = { getChannelFromToken } as unknown as ChannelService;
  const configService = { apiOptions: { channelTokenKey: 'vendure-token' } } as unknown as ConfigService;
  return {
    interceptor: new UnifiedSlugInterceptor(connection, channelService, configService),
    createQueryBuilder,
    getChannelFromToken,
  };
}

const nextHandler = (): CallHandler => ({ handle: (): Observable<unknown> => of('resolver-result') });

const run = async (context: ExecutionContext, interceptor: UnifiedSlugInterceptor) =>
  firstValueFrom((await interceptor.intercept(context, nextHandler())) as Observable<unknown>);

describe('UnifiedSlugInterceptor', () => {
  it.each(['createProduct', 'updateProduct', 'createCollection', 'updateCollection'])(
    'unifies the slugs of `%s`',
    async (fieldName) => {
      const input = {
        id: 128,
        translations: [
          { languageCode: 'en', slug: 'dresses' },
          { languageCode: 'uk', slug: '' },
        ],
      };
      const { interceptor } = makeInterceptor();
      await run(makeExecutionContext(fieldName, input), interceptor);
      expect(input.translations.map((t) => t.slug)).toEqual(['dresses', 'dresses']);
    },
  );

  it('mutates the very object the resolver will read, and still passes the result through', async () => {
    const translations = [{ languageCode: 'uk', slug: 'sukni' }];
    const input = { id: 128, translations };
    const { interceptor } = makeInterceptor([{ languageCode: 'pl', slug: '' }]);
    const result = await run(makeExecutionContext('updateCollection', input), interceptor);
    expect(result).toBe('resolver-result');
    // Same array instance, extended with the row the client never sent.
    expect(input.translations).toBe(translations);
    expect(translations).toEqual([
      { languageCode: 'uk', slug: 'sukni' },
      { languageCode: 'pl', slug: 'sukni' },
    ]);
  });

  it.each(['updateProductVariants', 'createFacet', 'search', 'updateCustomer'])(
    'passes `%s` through without a database call',
    async (fieldName) => {
      const { interceptor, createQueryBuilder } = makeInterceptor();
      const input = {
        id: 128,
        translations: [
          { languageCode: 'en', slug: 'dresses' },
          { languageCode: 'uk', slug: '' },
        ],
      };
      await run(makeExecutionContext(fieldName, input), interceptor);
      expect(createQueryBuilder).not.toHaveBeenCalled();
      expect(input.translations[1].slug).toBe('');
    },
  );

  it('does not query when the input carries no translations — an `enabled` toggle costs nothing', async () => {
    const { interceptor, createQueryBuilder } = makeInterceptor();
    await run(makeExecutionContext('updateProduct', { id: 128, enabled: false }), interceptor);
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('does not query on create — there are no existing rows to reconcile', async () => {
    const { interceptor, createQueryBuilder } = makeInterceptor();
    await run(
      makeExecutionContext('createCollection', { translations: [{ languageCode: 'uk', slug: 'sukni' }] }),
      interceptor,
    );
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('prefers the slug of the channel default language, resolved from the channel token header', async () => {
    const input = {
      translations: [
        { languageCode: 'uk', slug: 'sukni' },
        { languageCode: 'en', slug: 'dresses' },
      ],
    };
    const { interceptor, getChannelFromToken } = makeInterceptor();
    await run(makeExecutionContext('createProduct', input), interceptor);
    expect(getChannelFromToken).toHaveBeenCalledWith('default-token');
    expect(input.translations.map((t) => t.slug)).toEqual(['dresses', 'dresses']);
  });

  it('reads the channel token from the query string before the header, as core does', async () => {
    const { interceptor, getChannelFromToken } = makeInterceptor();
    const req = { headers: { 'vendure-token': 'header-token' }, query: { 'vendure-token': 'query-token' } };
    await run(makeExecutionContext('createProduct', { translations: [] }, undefined, req), interceptor);
    expect(getChannelFromToken).toHaveBeenCalledWith('query-token');
  });

  it('asks for the default channel when the request carries no token', async () => {
    const { interceptor, getChannelFromToken } = makeInterceptor();
    await run(makeExecutionContext('createProduct', { translations: [] }, undefined, { headers: {} }), interceptor);
    expect(getChannelFromToken).toHaveBeenCalledWith('');
  });

  it('survives a failed channel lookup — no channel default, still one slug in input order', async () => {
    const input = {
      translations: [
        { languageCode: 'uk', slug: 'sukni' },
        { languageCode: 'en', slug: 'dresses' },
      ],
    };
    const { interceptor } = makeInterceptor(
      [],
      vi.fn(async () => {
        throw new Error('unknown channel');
      }),
    );
    await run(makeExecutionContext('createProduct', input), interceptor);
    expect(input.translations.map((t) => t.slug)).toEqual(['sukni', 'sukni']);
  });

  it('survives a GraphQL context without a request — still one slug in input order', async () => {
    const input = {
      translations: [
        { languageCode: 'uk', slug: 'sukni' },
        { languageCode: 'en', slug: 'dresses' },
      ],
    };
    const { interceptor, getChannelFromToken } = makeInterceptor();
    const context = makeExecutionContext('createProduct', input);
    (context.getArgs() as unknown[])[2] = {};
    await run(context, interceptor);
    expect(getChannelFromToken).not.toHaveBeenCalled();
    expect(input.translations.map((t) => t.slug)).toEqual(['sukni', 'sukni']);
  });

  it('fails the mutation when the existing-rows read fails, rather than letting a divergent slug through', async () => {
    const { interceptor, createQueryBuilder } = makeInterceptor();
    createQueryBuilder.mockImplementation(() => {
      throw new Error('db down');
    });
    const input = { id: 128, translations: [{ languageCode: 'en', slug: 'dresses' }] };
    await expect(run(makeExecutionContext('updateProduct', input), interceptor)).rejects.toThrow('db down');
  });

  it('acts on an aliased mutation — the alias lives in `path.key`, `fieldName` stays the schema field', async () => {
    const input = { id: 128, translations: [{ languageCode: 'en', slug: 'dresses' }] };
    const { interceptor } = makeInterceptor([{ languageCode: 'pl', slug: '' }]);
    await run(makeExecutionContext('updateCollection', input, 'renamedCollection'), interceptor);
    expect(input.translations).toEqual([
      { languageCode: 'en', slug: 'dresses' },
      { languageCode: 'pl', slug: 'dresses' },
    ]);
  });

  it('unifies every element of the `updateProducts` array, each against its own existing rows', async () => {
    const input = [
      { id: 1, translations: [{ languageCode: 'uk', slug: 'sukni' }] },
      { id: 2, translations: [{ languageCode: 'en', slug: 'skirts' }] },
    ];
    const { interceptor, createQueryBuilder } = makeInterceptor([{ languageCode: 'pl', slug: '' }]);
    await run(makeExecutionContext('updateProducts', input), interceptor);
    expect(createQueryBuilder).toHaveBeenCalledTimes(2);
    expect(input[0].translations).toEqual([
      { languageCode: 'uk', slug: 'sukni' },
      { languageCode: 'pl', slug: 'sukni' },
    ]);
    expect(input[1].translations).toEqual([
      { languageCode: 'en', slug: 'skirts' },
      { languageCode: 'pl', slug: 'skirts' },
    ]);
  });

  it('passes an element without a `translations` array through untouched, and costs it no query', async () => {
    const input = [
      { id: 1, enabled: false },
      { id: 2, translations: null },
      { id: 3, translations: [{ languageCode: 'uk', slug: 'sukni' }] },
    ];
    const { interceptor, createQueryBuilder } = makeInterceptor([{ languageCode: 'pl', slug: '' }]);
    await run(makeExecutionContext('updateProducts', input), interceptor);
    expect(createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(input[0]).toEqual({ id: 1, enabled: false });
    expect(input[1]).toEqual({ id: 2, translations: null });
  });

  it('self-heals on `translations: []` — the canonical slug comes from the rows and pulls the divergent one back', async () => {
    const translations: Array<{ languageCode: string; slug: string }> = [];
    const input = { id: 128, translations };
    const { interceptor } = makeInterceptor([
      { languageCode: 'en', slug: 'dresses' },
      { languageCode: 'pl', slug: 'dresses-2' },
    ]);
    await run(makeExecutionContext('updateCollection', input), interceptor);
    expect(translations).toEqual([{ languageCode: 'pl', slug: 'dresses' }]);
  });

  it('gives duplicated `languageCode` entries the same canonical slug and de-duplicates nothing', async () => {
    const input = {
      translations: [
        { languageCode: 'en', slug: 'dresses' },
        { languageCode: 'en', slug: '' },
        { languageCode: 'uk', slug: 'sukni' },
      ],
    };
    const { interceptor } = makeInterceptor();
    await run(makeExecutionContext('createProduct', input), interceptor);
    expect(input.translations).toEqual([
      { languageCode: 'en', slug: 'dresses' },
      { languageCode: 'en', slug: 'dresses' },
      { languageCode: 'uk', slug: 'dresses' },
    ]);
  });

  it('ignores a non-GraphQL execution context', async () => {
    const { interceptor, createQueryBuilder } = makeInterceptor();
    const context = { getType: () => 'http' } as unknown as ExecutionContext;
    expect(await run(context, interceptor)).toBe('resolver-result');
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });
});
