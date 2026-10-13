import { INestApplication } from '@nestjs/common';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RequestContext, RequestContextService, TransactionalConnection, User } from '@vendure/core';
import { SimpleGraphQLClient } from '@vendure/testing';
import { ChangeHistoryEntry } from '../src';
import { CREATE_PRODUCT, CREATE_VARIANT, UNSETTLED_JOBS } from './graphql';

/** An Admin API context of the superadmin (the actor the history should record). */
export async function superadminCtx(app: INestApplication): Promise<RequestContext> {
  const user = await app
    .get(TransactionalConnection)
    .rawConnection.getRepository(User)
    .findOneOrFail({ where: { identifier: 'superadmin' } });
  return app.get(RequestContextService).create({ apiType: 'admin', user });
}

/** A context without a user, like a job or a scheduled task. */
export function systemCtx(app: INestApplication): Promise<RequestContext> {
  return app.get(RequestContextService).create({ apiType: 'admin' });
}

export async function entriesWhere(
  app: INestApplication,
  where: Partial<Record<keyof ChangeHistoryEntry, unknown>>,
): Promise<ChangeHistoryEntry[]> {
  return app
    .get(TransactionalConnection)
    .rawConnection.getRepository(ChangeHistoryEntry)
    .find({ where: where as never, order: { id: 'ASC' } });
}

/** The database id behind an Admin API id of the testing id strategy (`T_12` → `'12'`). */
export function decode(id: string): string {
  return id.replace(/^T_/, '');
}

/** A product with one variant per SKU; returns the product id and the variant ids. */
export async function createProduct(
  adminClient: SimpleGraphQLClient,
  name: string,
  skus: string[],
): Promise<{ productId: string; variantIds: string[] }> {
  const { createProduct } = await adminClient.query(CREATE_PRODUCT, { name });
  const variantIds: string[] = [];
  for (const sku of skus) {
    const { createProductVariants } = await adminClient.query(CREATE_VARIANT, { productId: createProduct.id, sku });
    variantIds.push(createProductVariants[0].id);
  }
  return { productId: createProduct.id, variantIds };
}

/**
 * Polls until `read` returns a value that `done` accepts (the collection filters run in a job, the history
 * handler after it). Returns the last value read, accepted or not, after `timeoutMs`.
 */
export async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
}

/** Waits until the job queue has no unsettled job (the filters job of every product and collection save). */
export async function settleJobs(adminClient: SimpleGraphQLClient): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await waitFor(
    async () => (await adminClient.query(UNSETTLED_JOBS)).jobs.totalItems as number,
    (unsettled) => unsettled === 0,
  );
}

/** Collection filter input: products with any of the facet values. */
export const facetFilter = (facetValueIds: string[]) => [
  {
    code: 'facet-value-filter',
    arguments: [
      { name: 'facetValueIds', value: JSON.stringify(facetValueIds) },
      { name: 'containsAny', value: 'true' },
    ],
  },
];

/** A 1×1 PNG, for asset uploads. */
export function pngFile(name: string): string {
  const file = path.join(tmpdir(), `change-history-${name}.png`);
  writeFileSync(
    file,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    ),
  );
  return file;
}
