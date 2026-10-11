import { ID, LanguageCode, RequestContext, Type } from '@vendure/core';
import { EntityManager, In } from 'typeorm';

interface Translated {
  languageCode: LanguageCode;
  name?: string;
}

/** The translation in the request language, else the channel's default language, else the first one. */
export function pickTranslation<T extends Translated>(
  translations: T[] | undefined,
  ctx: RequestContext,
): T | undefined {
  if (!translations?.length) {
    return undefined;
  }
  return (
    translations.find((t) => t.languageCode === ctx.languageCode) ??
    translations.find((t) => t.languageCode === ctx.channel?.defaultLanguageCode) ??
    translations[0]
  );
}

type Row = Record<string, unknown> & { id: ID; translations?: Translated[] };

function nameOf(row: Row | undefined, ctx: RequestContext): string | undefined {
  if (!row) {
    return undefined;
  }
  const translated = pickTranslation(row.translations, ctx)?.name;
  for (const candidate of [translated, row.name, row.code, row.identifier, row.sku]) {
    if (typeof candidate === 'string' && candidate !== '') {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Display labels of entities by id: the translated name, else `name` / `code` / `identifier` / `sku`. With a
 * `parent` relation (a facet value's facet, an option's group) the label is "Parent: Child". Ids that no
 * longer exist get no label; the dashboard then shows the id.
 */
export async function labelsOf(
  ctx: RequestContext,
  manager: EntityManager,
  target: Type<unknown>,
  ids: string[],
  parent?: string,
): Promise<Record<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return {};
  }
  const metadata = manager.connection.getMetadata(target);
  const translated = (meta: typeof metadata) => meta.relations.some((r) => r.propertyName === 'translations');
  const relations: string[] = [];
  if (translated(metadata)) {
    relations.push('translations');
  }
  if (parent) {
    relations.push(parent);
    const parentRelation = metadata.findRelationWithPropertyPath(parent);
    if (parentRelation && translated(parentRelation.inverseEntityMetadata)) {
      relations.push(`${parent}.translations`);
    }
  }
  const rows = (await manager.getRepository(target).find({
    where: { id: In(unique) },
    relations,
    loadEagerRelations: false,
    relationLoadStrategy: 'query',
  } as never)) as Row[];
  const labels: Record<string, string> = {};
  for (const row of rows) {
    const name = nameOf(row, ctx);
    if (name === undefined) {
      continue;
    }
    const parentName = parent ? nameOf(row[parent] as Row | undefined, ctx) : undefined;
    labels[String(row.id)] = parentName ? `${parentName}: ${name}` : name;
  }
  return labels;
}
