import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import {
  ChannelService,
  CollectionTranslation,
  ConfigService,
  type ID,
  ProductTranslation,
  TransactionalConnection,
} from '@vendure/core';
import { ExistingSlugRow, SlugTranslationInput, unifySlugs } from './unify-slugs';

/** The two request fields the channel token can arrive in — the Express `Request` subset this reads. */
interface ChannelTokenCarrier {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}

type SlugTranslationEntity = typeof ProductTranslation | typeof CollectionTranslation;

interface FieldSpec {
  translationEntity: SlugTranslationEntity;
  /** Whether the mutation targets an entity that already has translation rows in the database. */
  isUpdate: boolean;
}

/**
 * The only five resolver fields that can write a `slug`. `updateProducts` is real and takes a **list**
 * of the same `UpdateProductInput`
 * (`@vendure/core/dist/api/schema/admin-api/product.api.graphql:20`); there is no `updateCollections`
 * counterpart — `collection.api.graphql` has only the singular form. Every slug write goes through one
 * of these.
 */
const FIELD_SPECS: Readonly<Record<string, FieldSpec>> = {
  createProduct: { translationEntity: ProductTranslation, isUpdate: false },
  updateProduct: { translationEntity: ProductTranslation, isUpdate: true },
  updateProducts: { translationEntity: ProductTranslation, isUpdate: true },
  createCollection: { translationEntity: CollectionTranslation, isUpdate: false },
  updateCollection: { translationEntity: CollectionTranslation, isUpdate: true },
};

interface SlugMutationInput {
  id?: ID;
  translations?: SlugTranslationInput[] | null;
}

/** An input worth acting on: an object carrying a `translations` array, whatever else it holds. */
function carriesTranslations(input: unknown): input is SlugMutationInput {
  return !!input && typeof input === 'object' && Array.isArray((input as SlugMutationInput).translations);
}

/**
 * Holds the write-side invariant: **one slug per entity, identical in every language**.
 *
 * The rule itself is `unifySlugs` in `./unify-slugs.ts`; this class is only the plumbing that gives it
 * the two things it needs (the channel's default language, and the entity's existing translation rows)
 * and applies its answer.
 *
 * ## Why an interceptor, and why in place
 *
 * The input is rewritten **before** the core resolver runs, so the corrected slugs are carried by the
 * mutation's own `@Transaction()` write. No follow-up write, no event subscriber, no job: an entity is
 * never observable in a half-unified state, and nothing has to be undone if the mutation fails. The
 * existing-rows *read* below is a different matter: it goes through `rawConnection` and runs before the
 * resolver's `@Transaction()`, so it is **not** inside the mutation's transaction — only the write is.
 * Registering an `APP_INTERCEPTOR` from a plugin's `providers` is a supported Vendure pattern —
 * `@vendure/core/dist/plugin/vendure-plugin.js:60` special-cases it (vendure#837). All five fields are
 * root `Mutation` fields, where Nest does apply interceptors.
 *
 * `args.input` keeps its object identity and `input.translations` keeps its array identity; only the
 * contents are replaced. The interceptor is global, so it bails out on the field-name check before
 * touching anything else.
 *
 * ## Failing the mutation when that read fails is deliberate
 *
 * Awaiting the read before `next.handle()` means a rejected existing-rows SELECT aborts the mutation rather
 * than letting it through unmodified: silently skipping the invariant writes a divergent slug nobody
 * will notice, which is worse than failing a write the database was, in that state, likely to refuse
 * anyway.
 *
 * ## `translations: []` is honoured, not skipped
 *
 * An update carrying an **empty** `translations` array still costs one query and can still append
 * slug-only patches — rule (c) picks the canonical slug from the existing rows and pulls any divergent
 * ones onto it. That is deliberate self-healing: it is the cheapest way to repair an entity whose rows
 * drifted apart (see the `SlugValidator` note below), and it changes no translation content, because
 * the client sent none.
 *
 * ## What a slug-only translation input does to an existing row (verified, @vendure/core 3.7.2,
 * typeorm 0.3.28)
 *
 * On update we append `{ languageCode, slug }` for languages the client did not send. That is a
 * partial translation input, and the question it raises — does it blank `name` / `description` /
 * `customFields`? — is answered no, at four hops:
 *
 * 1. `TranslationDiffer.translationInputsToEntities`
 *    (`@vendure/core/dist/service/helpers/translatable-saver/translation-differ.js:61-72`) builds
 *    `new translationCtor(input)` and then copies **only** the id and `base` off the existing row.
 * 2. That constructor is `VendureEntity`'s (`@vendure/core/dist/entity/base/base.entity.js:23-35`),
 *    which assigns exactly the keys present on the input object. So `name`, `description` and
 *    `customFields` are left `undefined` on the entity — not `null`, not `''`.
 * 3. TypeORM's update path skips undefined properties by design:
 *    `typeorm/persistence/SubjectChangedColumnsComputer.js:48-51` — *"we don't perform operation over
 *    undefined properties (but we DO need null properties!)"*. The emitted `UPDATE` therefore carries
 *    `slug` (and `updatedAt`) and nothing else. The embedded `customFields` columns are skipped by the
 *    same rule: `ColumnMetadata.getEntityValue` (`typeorm/metadata/ColumnMetadata.js:431-455`) returns
 *    `undefined` when the embedded object itself is absent, rather than reading through it.
 * 4. Omitting a language never deletes its row. `TranslationDiffer.diff`
 *    (`translation-differ.js:18-31`) produces only `toAdd` and `toUpdate` — there is no `toRemove` —
 *    and `TranslatableSaver.update`
 *    (`@vendure/core/dist/service/helpers/translatable-saver/translatable-saver.js:79-98`) seeds the
 *    entity with `translations: existingTranslations` and patches it with `omit(input,
 *    ['translations'])`. Rows the client never mentions survive untouched.
 *
 * ## Why we never call `normalizeString` ourselves
 *
 * `SlugValidator.validateSlugs` runs after us and before the saver (`collection.service.js:433`,
 * `product.service.js:214`) and normalises each translation's slug
 * (`@vendure/core/dist/service/helpers/slug-validator/slug-validator.js:36`). Identical input in,
 * identical output out, so unified slugs stay unified. Its uniqueness probe is scoped per
 * `languageCode` and excludes the entity being updated (`slug-validator.js:49-54`), so one entity
 * carrying the same slug in every language never collides with itself.
 *
 * The one case that can still re-diverge: if a **different** entity in the channel already owns the
 * slug in some but not all of the languages, the `-2` suffixing (`slug-validator.js:59-67`) fires only
 * for those languages. The next write through this interceptor pulls them back together. See the
 * README's runbook for how to find such rows.
 */
@Injectable()
export class UnifiedSlugInterceptor implements NestInterceptor {
  constructor(
    private readonly connection: TransactionalConnection,
    private readonly channelService: ChannelService,
    private readonly configService: ConfigService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<ReturnType<CallHandler['handle']>> {
    if (context.getType<GqlContextType>() !== 'graphql') {
      return next.handle();
    }
    const gqlContext = GqlExecutionContext.create(context);
    // Global interceptor: bail out as early and as cheaply as possible on every other resolver field.
    // This is the *schema* field name, so an aliased mutation is matched just the same.
    const fieldName = gqlContext.getInfo<{ fieldName?: string }>()?.fieldName;
    const spec = fieldName ? FIELD_SPECS[fieldName] : undefined;
    if (!spec) {
      return next.handle();
    }

    // `updateProducts` takes a list of the same input; the other four take a single object.
    const arg = gqlContext.getArgs<{ input?: unknown }>()?.input;
    // No `translations` key at all means there is nothing to unify — an update that only toggles
    // `enabled` must not cost a query.
    const inputs = (Array.isArray(arg) ? arg : [arg]).filter(carriesTranslations);
    if (inputs.length === 0) {
      return next.handle();
    }

    await this.applyUnifiedSlugs(gqlContext, spec, inputs);
    return next.handle();
  }

  /** One entity at a time: every element of a bulk input gets its own existing-rows lookup. */
  private async applyUnifiedSlugs(
    gqlContext: GqlExecutionContext,
    spec: FieldSpec,
    inputs: SlugMutationInput[],
  ): Promise<void> {
    const channelDefaultLanguageCode = await this.getChannelDefaultLanguageCode(gqlContext);
    for (const input of inputs) {
      await this.applyUnifiedSlug(spec, input, channelDefaultLanguageCode);
    }
  }

  private async applyUnifiedSlug(
    spec: FieldSpec,
    input: SlugMutationInput,
    channelDefaultLanguageCode: string | undefined,
  ): Promise<void> {
    const existingRows =
      spec.isUpdate && input.id != null ? await this.loadExistingRows(spec.translationEntity, input.id) : [];
    const unified = unifySlugs(input.translations, existingRows, channelDefaultLanguageCode);
    if (!unified) {
      return;
    }
    // Replace the contents, not the array: whatever else holds a reference to it sees the new slugs.
    const translations = input.translations as SlugTranslationInput[];
    translations.length = 0;
    translations.push(...unified);
  }

  /**
   * The channel the request runs in, resolved the way core's `RequestContextService` resolves it: the
   * channel token from the query string, else from the header, looked up in the channel cache (no
   * database hit). The AuthGuard has already validated that token by the time interceptors run.
   *
   * Any failure simply means no channel-default preference — `unifySlugs` then falls back to input
   * order, which is still a single slug. A missing channel must not fail the mutation.
   */
  private async getChannelDefaultLanguageCode(gqlContext: GqlExecutionContext): Promise<string | undefined> {
    const req = gqlContext.getContext<{ req?: ChannelTokenCarrier }>()?.req;
    if (!req) {
      return undefined;
    }
    const tokenKey = this.configService.apiOptions.channelTokenKey;
    const token = req.query?.[tokenKey] || req.headers?.[tokenKey] || '';
    try {
      const channel = await this.channelService.getChannelFromToken(String(token));
      return channel?.defaultLanguageCode;
    } catch {
      return undefined;
    }
  }

  private loadExistingRows(translationEntity: SlugTranslationEntity, baseId: ID): Promise<ExistingSlugRow[]> {
    return this.connection.rawConnection
      .getRepository(translationEntity)
      .createQueryBuilder('translation')
      .select('translation.languageCode', 'languageCode')
      .addSelect('translation.slug', 'slug')
      .where('translation.baseId = :baseId', { baseId })
      .orderBy('translation.languageCode', 'ASC')
      .getRawMany<ExistingSlugRow>();
  }
}
