import { INestApplication } from '@nestjs/common';
import { RequestContext, RequestContextService, TransactionalConnection, User } from '@vendure/core';
import { SimpleGraphQLClient } from '@vendure/testing';
import { ChangeHistoryEntry } from '../src';
import { CREATE_PRODUCT, CREATE_VARIANT } from './graphql';

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
