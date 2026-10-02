import { Inject, Injectable } from '@nestjs/common';
import type { RequestContext } from '@vendure/core';
import { NOVA_POSHTA_PLUGIN_OPTIONS } from './constants';
import { NovaPoshtaError } from './nova-poshta-error';
import type { ResolvedNovaPoshtaPluginOptions } from './types';

interface NovaPoshtaResponse<T> {
  success: boolean;
  data: T;
  errors?: string[];
  errorCodes?: string[];
}

/**
 * @description
 * The JSON API of Nova Poshta (`modelName` + `calledMethod` + `methodProperties`), with the API key
 * resolved for the request. Exported so a host can call methods this plugin does not wrap — creating a
 * waybill, tracking a parcel — with the same key and error handling.
 *
 * @example
 * ```ts
 * const statuses = await client.request(ctx, 'TrackingDocument', 'getStatusDocuments', {
 *   Documents: [{ DocumentNumber: '20450000000000' }],
 * });
 * ```
 */
@Injectable()
export class NovaPoshtaClient {
  constructor(@Inject(NOVA_POSHTA_PLUGIN_OPTIONS) private readonly options: ResolvedNovaPoshtaPluginOptions) {}

  /** Returns `data` of the answer. Throws {@link NovaPoshtaError} on any failure. */
  async request<T>(
    ctx: RequestContext,
    modelName: string,
    calledMethod: string,
    methodProperties: Record<string, unknown> = {},
  ): Promise<T> {
    const apiKey = await this.options.apiKeyStrategy.getApiKey(ctx);
    if (!apiKey) {
      throw new NovaPoshtaError('No Nova Poshta API key: the apiKey strategy returned none');
    }
    const method = `${modelName}.${calledMethod}`;

    let response: Response;
    try {
      response = await fetch(this.options.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, modelName, calledMethod, methodProperties }),
        signal: AbortSignal.timeout(this.options.timeout),
      });
    } catch (cause) {
      throw new NovaPoshtaError(`Nova Poshta ${method} failed: ${describe(cause)}`, { cause });
    }
    // Nova Poshta sends its usual envelope with a non-2xx too: a wrong key is HTTP 401 with
    // `errors: ['API key incorrect']`.
    let body: NovaPoshtaResponse<T> | undefined;
    try {
      body = (await response.json()) as NovaPoshtaResponse<T>;
    } catch (cause) {
      if (response.ok) throw new NovaPoshtaError(`Nova Poshta ${method} answered with invalid JSON`, { cause });
    }
    if (!response.ok || !body?.success) {
      const errors = body?.errors ?? [];
      const reason = [response.ok ? undefined : `HTTP ${response.status}`, ...errors].filter(Boolean).join(': ');
      throw new NovaPoshtaError(`Nova Poshta ${method} failed: ${reason || 'no reason given'}`, {
        errors,
        errorCodes: body?.errorCodes,
        status: response.ok ? undefined : response.status,
      });
    }
    return body.data;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
