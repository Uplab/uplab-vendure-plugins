<p align="center">
  <img src="https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-unified-slug/assets/icon.svg" alt="" width="96" height="96">
</p>

# @uplab/vendure-plugin-unified-slug

[![npm](https://img.shields.io/npm/v/@uplab/vendure-plugin-unified-slug.svg)](https://www.npmjs.com/package/@uplab/vendure-plugin-unified-slug)
[![Vendure](https://img.shields.io/badge/Vendure-%5E3.7.0-17c9ff.svg)](https://www.vendure.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/Uplab/uplab-vendure-plugins/blob/main/LICENSE)

**One slug per product and collection, identical in every language** — enforced on the server for
every API client, and shown in the dashboard as a single slug field instead of one per language tab.

Vendure stores a `slug` on every translation row, so each language can have its own. Many shops do
not want that: the storefront resolves a slug without knowing the language
(`ProductService.findOneBySlug` and `CollectionService.findOneBySlug` already match a slug in **any**
language), and divergent or empty per-language slugs only cause broken links.

The empty ones happen on their own. The dashboard's stock slug field generates a slug only when an
entity is **created** (`isReadonly && !entityId && watchFieldState.isDirty` in
`@vendure/dashboard/src/lib/components/data-input/slug-input.tsx`). Open an existing collection,
switch to a language tab it has no translation for yet, type a name and save: that translation is
stored with `slug: ''`, and nothing complains. This plugin closes that gap on both sides.

Compatible with **Vendure ^3.7.0**.

### Who this is not for

Shops that **intentionally** give each language its own slug (`/uk/sukni`, `/en/dresses`) for SEO.
This plugin overwrites a divergent slug with the canonical one on every write — that is the point of
it, and there is no switch to turn it off per language.

## Contents

[Install](#install) · [Usage](#usage) · [What it looks like](#what-it-looks-like) ·
[How it works](#how-it-works) · [Options](#options) · [Custom slug strategy](#custom-slug-strategy) ·
[GraphQL surface](#graphql-surface) · [Backfilling existing rows](#backfilling-existing-rows) ·
[Limitations](#limitations)

## Install

```bash
npm install @uplab/vendure-plugin-unified-slug
# or
pnpm add @uplab/vendure-plugin-unified-slug
```

`@vendure/core` and `@nestjs/*` are peer dependencies — the plugin uses the copies already in your
project. The dashboard extension additionally uses `@vendure/dashboard` and the React libraries it
ships with; those peers are optional, so a server without the React dashboard needs none of them.

## Usage

```ts
import { VendureConfig } from '@vendure/core';
import { UnifiedSlugPlugin } from '@uplab/vendure-plugin-unified-slug';

export const config: VendureConfig = {
  // ...
  plugins: [UnifiedSlugPlugin.init()],
};
```

That is all. There are no entities, so no migration; no jobs; no environment variables. If you use
the React dashboard, its Vite plugin (`vendureDashboardPlugin`) discovers the extension from the
package on its own — restart the dashboard dev server or rebuild it.

## What it looks like

The product and collection detail pages get one slug field. Whichever content language is active,
it shows the same value, and a change made in any language is written to all of them.

![The same slug on the English and Ukrainian versions of a product](https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-unified-slug/assets/product-detail.png)

Adding a language to an existing collection: the new translation already carries the slug, and is
saved with it. With the stock field, this translation would be saved with `slug: ''`.

![Adding Polish to an existing collection](https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-unified-slug/assets/add-language.png)

Unlike the stock field, it also generates a slug on an **existing** entity. A product imported or
saved without a slug gets one as soon as the name is edited — the stock field only does this on
create.

![An existing product with an empty slug gets one when its name is edited](https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-unified-slug/assets/auto-generate-on-update.png)

The edit button switches the field to manual entry (the lock switches it back), and the refresh
button regenerates the slug from the current name — also on an entity that has no slug yet.

![Manual editing of the slug](https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-unified-slug/assets/manual-edit.png)

## How it works

Three parts. The server part holds the invariant; the dashboard part stops the admin UI from asking a
human to hold it by hand; the slug strategy decides what a generated slug says.

### 1. Server — a global interceptor

An `APP_INTERCEPTOR` that acts on exactly five Admin API fields: `createProduct`, `updateProduct`,
`updateProducts`, `createCollection` and `updateCollection`. Every other field is passed through on a
field-name check before anything else happens (an aliased mutation is caught just the same — the check
reads the schema field name). `updateProducts` takes a list; each element is unified on its own.

It rewrites `input.translations` **before** the core resolver runs, so the corrected slugs are carried
by the mutation's own transactional write. There is no follow-up write, no event subscriber and no
job: an entity is never observable half-unified, and nothing needs undoing when the mutation fails.

**Choosing the canonical slug**, in order:

1. the input translation for the channel's default language, if its slug is non-empty;
2. otherwise the first input translation with a non-empty slug, in input order;
3. _update only_ — otherwise the existing row for the channel's default language, else the first
   non-empty existing row in `languageCode` order;
4. otherwise the input is passed through untouched, and core validation decides. **A slug is never
   invented.**

**Applying it:**

- every translation in the input gets the canonical slug — including one that arrived with a
  _different_ non-empty slug;
- _update only_ — for every existing row whose language is **not** in the input and whose slug
  differs, a `{ languageCode, slug }` translation is appended. That patches the slug and nothing else:
  it does not blank `name`, `description` or custom fields, and leaving a language out never deletes
  its row (verified against `@vendure/core` 3.7 and `typeorm` 0.3; the reasoning, with file
  references, is in the doc comment of `unified-slug.interceptor.ts`).

**Details that matter:**

- An empty or whitespace-only slug counts as empty. The canonical slug is trimmed.
- An update that sends no `translations` key — say, toggling `enabled` — costs no query. Creates
  never query either.
- An update with `translations: []` is **not** a no-op: it reads the existing rows and pulls any that
  drifted apart back onto one slug. That is the cheapest way to repair one entity.
- When reading the existing rows fails, the mutation fails, deliberately: letting it through would
  silently write a divergent slug.
- The channel's default language is resolved from the channel token of the request, exactly as core
  resolves it. If that lookup fails, the input order decides — still one slug.
- The plugin never normalises a slug itself. Core's `SlugValidator` runs afterwards and normalises
  every translation identically, so unified slugs stay unified.

### 2. Dashboard — one slug field

The extension replaces the `slug` input in the `main-form` block of the `product-detail` and
`collection-detail` pages. The field:

- shows **one** value on every language tab — the channel default language's slug, else the first
  non-empty one;
- on change, writes that value into every translation in play (see below);
- while the slug is empty and in automatic mode, generates it from the channel default language's
  name (falling back to the name in the language being edited) once the admin stops typing (500 ms)
  — **on update as well as on create**;
- keeps the stock field's lock/edit toggle and regenerate button.

The value is written only into translations already in play — the language being edited,
translations that exist in the database, translations the admin has typed into. The dashboard drops
translations that are neither edited nor saved before it submits
([vendure#4885](https://github.com/vendurehq/vendure/issues/4885)); touching the others would make
them count as edited and save them with an empty name. A language left untouched now and filled in
later gets the canonical slug from the server at that write.

### 3. Slug generation

The dashboard field asks this plugin's `unifiedSlugGenerate` query instead of core's `slugForEntity`.
It runs the configured [slug strategy](#custom-slug-strategy) to build the base, then hands it to core's
`EntitySlugService` — the same service `slugForEntity` uses — which passes it through your configured
core `SlugStrategy` and appends `-1`, `-2`… until it is unique. With the default strategy the answer is
exactly what `slugForEntity` would give.

`SlugGenerationService` is exported, so an importer or another plugin can produce the same slug the
dashboard would:

```ts
const slug = await slugGenerationService.generate(ctx, {
  entityName: 'Product',
  name: 'Summer dress',
  context: {},
});
```

## Options

| Option         | Type                  | Default                            | Description                                                                            |
| -------------- | --------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `slugStrategy` | `UnifiedSlugStrategy` | `new DefaultUnifiedSlugStrategy()` | What a generated slug says. The default is the name, as core's `slugForEntity` has it. |

## Custom slug strategy

Implement `UnifiedSlugStrategy` when a generated slug should say more than the name. The strategy
returns the slug's _base_; normalising and uniqueness stay core's.

```ts
import { RequestContext } from '@vendure/core';
import { UnifiedSlugBaseInput, UnifiedSlugPlugin, UnifiedSlugStrategy } from '@uplab/vendure-plugin-unified-slug';

/** "summer-dress-acme": product slugs carry the brand custom field. */
class BrandSlugStrategy implements UnifiedSlugStrategy {
  // Detail-form paths the dashboard should send along. It also regenerates an empty slug when one changes.
  readonly watchFormFields = ['customFields.brand'];

  generateBase(ctx: RequestContext, { entityName, name, context }: UnifiedSlugBaseInput): string {
    const brand = entityName === 'Product' ? context['customFields.brand'] : undefined;
    return typeof brand === 'string' && brand ? `${name} ${brand}` : name;
  }
}

UnifiedSlugPlugin.init({ slugStrategy: new BrandSlugStrategy() });
```

- `generateBase` may be async. Return `''` when there is nothing to build a slug from — the plugin
  then answers `''` rather than inventing one.
- `watchFormFields` are react-hook-form paths in the product / collection detail form. For a relation
  custom field the form holds the id under `customFields.<name>Id`. Values arrive in `context` keyed
  by path; a caller without a form (an importer, a script) passes whatever it has, or `{}`.
- The base is passed through your core `SlugStrategy` afterwards. The default one lower-cases,
  strips diacritics, drops every character outside `a-z`, `0-9`, spaces and hyphens, and turns
  spaces into hyphens — so a name in Cyrillic yields an **empty** slug. If your catalogue is named
  in Ukrainian or another non-Latin script, transliterate in `generateBase` (with a library such as
  [`slugify`](https://www.npmjs.com/package/slugify) or [`slug`](https://www.npmjs.com/package/slug))
  and return Latin text.
- The strategy is an `InjectableStrategy`: the plugin calls `init(injector)` on bootstrap and
  `destroy()` on shutdown, so it can resolve services such as `TransactionalConnection`.

## GraphQL surface

Admin API only, both queries gated by `Permission.Authenticated` — the same gate as core's
`slugForEntity`, which the dashboard field replaces.

```graphql
input UnifiedSlugGenerateInput {
  entityName: String! # 'Product' or 'Collection'; anything else is a UserInputError
  name: String!
  entityId: ID # excluded from the uniqueness check, so an entity never collides with itself
  context: JSON # passed to the slug strategy verbatim
}

type UnifiedSlugSettings {
  watchFormFields: [String!]!
}

extend type Query {
  unifiedSlugGenerate(input: UnifiedSlugGenerateInput!): String!
  unifiedSlugSettings: UnifiedSlugSettings!
}
```

The plugin adds no mutations: the slug itself is still written through core's `createProduct`,
`updateCollection` and the rest.

## Backfilling existing rows

The plugin fixes rows when they are written. Rows already in your database keep what they hold until
their entity is saved again. To fix one entity, send `updateProduct` / `updateCollection` with
`translations: []`. To find and fix them all, use the queries below (PostgreSQL; adapt the quoting for
MySQL/MariaDB). They carry `'en'` as a literal, marked `-- channel defaultLanguageCode` — replace it
with your channel's default language:

```sql
SELECT code, "defaultLanguageCode" FROM channel;
```

**1. Empty slugs next to a sibling that has one** — safe to fix automatically:

```sql
SELECT 'collection' AS entity, t."baseId", t."languageCode", t.name
FROM collection_translation t
WHERE btrim(t.slug) = ''
  AND EXISTS (SELECT 1 FROM collection_translation s WHERE s."baseId" = t."baseId" AND btrim(s.slug) <> '')
UNION ALL
SELECT 'product', t."baseId", t."languageCode", t.name
FROM product_translation t
WHERE btrim(t.slug) = ''
  AND EXISTS (SELECT 1 FROM product_translation s WHERE s."baseId" = t."baseId" AND btrim(s.slug) <> '')
ORDER BY 1, 2, 3;
```

**2. Slugs that disagree** — **not** safe to fix automatically: picking one changes a live URL, so
decide per entity (and add a redirect if your storefront needs one):

```sql
SELECT 'collection' AS entity, "baseId", array_agg("languageCode" || '=' || slug ORDER BY "languageCode") AS slugs
FROM collection_translation
WHERE btrim(slug) <> ''
GROUP BY "baseId"
HAVING count(DISTINCT slug) > 1
UNION ALL
SELECT 'product', "baseId", array_agg("languageCode" || '=' || slug ORDER BY "languageCode")
FROM product_translation
WHERE btrim(slug) <> ''
GROUP BY "baseId"
HAVING count(DISTINCT slug) > 1
ORDER BY 1, 2;
```

**3. Fill the empty slugs** with the entity's canonical slug, chosen by the same rule the interceptor
applies. The `NOT EXISTS` guards skip rows whose canonical slug another entity already owns in that
language, and entities that share a canonical slug: the database has no unique index on `slug`, so
nothing would refuse the duplicate. Those stay empty and need a human. Run it in a transaction, check
the counts, then commit.

```sql
BEGIN;

WITH canonical AS (
  SELECT DISTINCT ON ("baseId") "baseId", slug
  FROM collection_translation
  WHERE btrim(slug) <> ''
  ORDER BY "baseId", ("languageCode" = 'en') DESC, "languageCode"   -- channel defaultLanguageCode
)
UPDATE collection_translation AS target
SET slug = canonical.slug
FROM canonical
WHERE canonical."baseId" = target."baseId"
  AND btrim(target.slug) = ''
  AND NOT EXISTS (
    SELECT 1 FROM collection_translation AS o
    WHERE o."baseId" <> target."baseId"
      AND o."languageCode" = target."languageCode"
      AND o.slug = canonical.slug
  )
  AND NOT EXISTS (
    SELECT 1 FROM canonical AS other
    WHERE other."baseId" <> canonical."baseId"
      AND other.slug = canonical.slug
  );

-- Repeat with product_translation in place of collection_translation.

COMMIT;
```

If your search index stores slugs, reindex afterwards.

For a backfill script in TypeScript, the package exports the rule itself: `unifySlugs(inputTranslations,
existingRows, channelDefaultLanguageCode)` is the pure function the interceptor applies. It returns
the translations to save, or `null` when nothing needs to change.

## Limitations

- **Two write paths bypass the interceptor**: `duplicateEntity` and the CSV importer call the
  services directly. Both are still consistent in practice — the duplicators derive each language's
  slug from that language's own source row (`slug + '-copy'`), so a copy of a unified entity is
  unified; an import is as unified as its input file.
- **Uniqueness can re-split one entity.** Core's `SlugValidator` checks uniqueness per language. If a
  _different_ entity already owns the slug in some languages but not others, core suffixes only those
  (`dresses-2` in `en`, `dresses` in `uk`). The next write through the plugin pulls them back
  together; query 2 above finds any that are currently apart.
- **Only products and collections.** Facets, facet values and other translatable entities with a
  `code` are untouched.

## Changelog

See [CHANGELOG.md](https://github.com/Uplab/uplab-vendure-plugins/blob/main/packages/vendure-plugin-unified-slug/CHANGELOG.md).

## License

[MIT](https://github.com/Uplab/uplab-vendure-plugins/blob/main/LICENSE) © Uplab
