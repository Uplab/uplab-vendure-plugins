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

/** The Express `Request` subset the channel token is read from. */
interface ChannelTokenCarrier {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}

type SlugTranslationEntity = typeof ProductTranslation | typeof CollectionTranslation;

interface FieldSpec {
  translationEntity: SlugTranslationEntity;
  /** Whether the entity already has translation rows to reconcile against. */
  isUpdate: boolean;
}

/** The Admin API mutations that can write a `slug`. There is no `updateCollections`. */
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

function carriesTranslations(input: unknown): input is SlugMutationInput {
  return !!input && typeof input === 'object' && Array.isArray((input as SlugMutationInput).translations);
}

/** A repeated query parameter arrives as an array; the first value is the token. */
function firstString(value: unknown): string {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' ? single : '';
}

/**
 * Rewrites `input.translations` of the slug-writing mutations before the core resolver runs, so the
 * unified slugs travel in the mutation's own transactional write — nothing to undo if it fails, and
 * an entity is never observable half-unified. The rule itself is `unifySlugs`.
 *
 * On update, languages the client did not send get a slug-only `{ languageCode, slug }` input. That
 * is safe: core's `TranslationDiffer` builds the translation entity from the input's own keys and
 * TypeORM skips undefined columns, so `name`, `description` and custom fields of that row stay as
 * they are; a language left out of the input is never deleted. Core's `SlugValidator` normalises
 * every slug after this interceptor, identically per language, so unified slugs stay unified.
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
    // The schema field name, so an aliased mutation matches too. Own properties only: a field named
    // `constructor` or `toString` must not hit `Object.prototype`.
    const fieldName = gqlContext.getInfo<{ fieldName?: string }>()?.fieldName;
    const spec = fieldName && Object.hasOwn(FIELD_SPECS, fieldName) ? FIELD_SPECS[fieldName] : undefined;
    if (!spec) {
      return next.handle();
    }

    // `updateProducts` takes a list; the others a single input. An input without `translations`
    // (an `enabled` toggle, say) must not cost a query.
    const arg = gqlContext.getArgs<{ input?: unknown }>()?.input;
    const inputs = (Array.isArray(arg) ? arg : [arg]).filter(carriesTranslations);
    if (inputs.length === 0) {
      return next.handle();
    }

    // Awaited before `next.handle()` on purpose: a failed existing-rows read fails the mutation
    // rather than letting a divergent slug through unnoticed.
    const channelDefaultLanguageCode = await this.getChannelDefaultLanguageCode(gqlContext);
    for (const input of inputs) {
      await this.applyUnifiedSlug(spec, input, channelDefaultLanguageCode);
    }
    return next.handle();
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
    // Replace the contents, not the array: the resolver reads the same object.
    const translations = input.translations as SlugTranslationInput[];
    translations.length = 0;
    translations.push(...unified);
  }

  /**
   * The request's channel, resolved the way core's `RequestContextService` does: token from the
   * query string, else the header, through core's channel cache. A failed lookup means no default
   * language preference — `unifySlugs` then goes by input order, which is still one slug.
   */
  private async getChannelDefaultLanguageCode(gqlContext: GqlExecutionContext): Promise<string | undefined> {
    const req = gqlContext.getContext<{ req?: ChannelTokenCarrier }>()?.req;
    if (!req) {
      return undefined;
    }
    const tokenKey = this.configService.apiOptions.channelTokenKey;
    const token = firstString(req.query?.[tokenKey]) || firstString(req.headers?.[tokenKey]);
    try {
      const channel = await this.channelService.getChannelFromToken(token);
      return channel?.defaultLanguageCode;
    } catch {
      return undefined;
    }
  }

  /** Outside the mutation's transaction on purpose: only the write has to be inside it. */
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
