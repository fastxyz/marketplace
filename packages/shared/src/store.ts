import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type {
  AccessGrantRecord,
  CreateSuggestionInput,
  IdempotencyRecord,
  JobRecord,
  MarketplaceStore,
  ProviderAttemptRecord,
  ResourceType,
  RefundRecord,
  SaveAsyncAcceptanceInput,
  SaveSyncIdempotencyInput,
  ServiceAnalytics,
  SuggestionRecord,
  SuggestionStatus,
  UpdateSuggestionInput
} from "./types.js";

function timestamp(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryMarketplaceStore implements MarketplaceStore {
  private readonly idempotencyByPaymentId = new Map<string, IdempotencyRecord>();
  private readonly jobsByToken = new Map<string, JobRecord>();
  private readonly accessGrants = new Map<string, AccessGrantRecord>();
  private readonly refundsById = new Map<string, RefundRecord>();
  private readonly refundsByJobToken = new Map<string, RefundRecord>();
  private readonly suggestionsById = new Map<string, SuggestionRecord>();
  private readonly attempts: ProviderAttemptRecord[] = [];

  async ensureSchema(): Promise<void> {}

  async getIdempotencyByPaymentId(paymentId: string): Promise<IdempotencyRecord | null> {
    return clone(this.idempotencyByPaymentId.get(paymentId) ?? null);
  }

  async saveSyncIdempotency(input: SaveSyncIdempotencyInput): Promise<IdempotencyRecord> {
    const now = timestamp();
    const record: IdempotencyRecord = {
      paymentId: input.paymentId,
      normalizedRequestHash: input.normalizedRequestHash,
      buyerWallet: input.buyerWallet,
      routeId: input.routeId,
      routeVersion: input.routeVersion,
      quotedPrice: input.quotedPrice,
      payoutSplit: clone(input.payoutSplit),
      paymentPayload: input.paymentPayload,
      facilitatorResponse: clone(input.facilitatorResponse),
      responseKind: "sync",
      responseStatusCode: input.statusCode,
      responseBody: clone(input.body),
      responseHeaders: clone(input.headers ?? {}),
      createdAt: now,
      updatedAt: now
    };

    this.idempotencyByPaymentId.set(record.paymentId, record);
    return clone(record);
  }

  async saveAsyncAcceptance(input: SaveAsyncAcceptanceInput): Promise<{ idempotency: IdempotencyRecord; job: JobRecord }> {
    const now = timestamp();
    const idempotency: IdempotencyRecord = {
      paymentId: input.paymentId,
      normalizedRequestHash: input.normalizedRequestHash,
      buyerWallet: input.buyerWallet,
      routeId: input.route.routeId,
      routeVersion: input.route.version,
      quotedPrice: input.quotedPrice,
      payoutSplit: clone(input.payoutSplit),
      paymentPayload: input.paymentPayload,
      facilitatorResponse: clone(input.facilitatorResponse),
      responseKind: "job",
      responseStatusCode: 202,
      responseBody: clone(input.responseBody),
      responseHeaders: clone(input.responseHeaders ?? {}),
      jobToken: input.jobToken,
      createdAt: now,
      updatedAt: now
    };

    const job: JobRecord = {
      jobToken: input.jobToken,
      paymentId: input.paymentId,
      routeId: input.route.routeId,
      provider: input.route.provider,
      operation: input.route.operation,
      buyerWallet: input.buyerWallet,
      quotedPrice: input.quotedPrice,
      payoutSplit: clone(input.payoutSplit),
      providerJobId: input.providerJobId,
      requestBody: clone(input.requestBody),
      providerState: clone(input.providerState ?? null),
      status: "pending",
      resultBody: null,
      errorMessage: null,
      refundStatus: "not_required",
      refundId: null,
      createdAt: now,
      updatedAt: now
    };

    this.idempotencyByPaymentId.set(idempotency.paymentId, idempotency);
    this.jobsByToken.set(job.jobToken, job);

    return {
      idempotency: clone(idempotency),
      job: clone(job)
    };
  }

  async getJob(jobToken: string): Promise<JobRecord | null> {
    return clone(this.jobsByToken.get(jobToken) ?? null);
  }

  async listPendingJobs(limit: number): Promise<JobRecord[]> {
    return clone(
      Array.from(this.jobsByToken.values())
        .filter((job) => job.status === "pending")
        .slice(0, limit)
    );
  }

  async updateJobPending(jobToken: string, providerState?: Record<string, unknown>): Promise<JobRecord> {
    const existing = this.jobsByToken.get(jobToken);
    if (!existing) {
      throw new Error(`Job not found: ${jobToken}`);
    }

    const updated: JobRecord = {
      ...existing,
      providerState: clone(providerState ?? existing.providerState),
      updatedAt: timestamp()
    };

    this.jobsByToken.set(jobToken, updated);
    return clone(updated);
  }

  async completeJob(jobToken: string, body: unknown): Promise<JobRecord> {
    const existing = this.jobsByToken.get(jobToken);
    if (!existing) {
      throw new Error(`Job not found: ${jobToken}`);
    }

    const updated: JobRecord = {
      ...existing,
      status: "completed",
      resultBody: clone(body),
      errorMessage: null,
      updatedAt: timestamp()
    };

    this.jobsByToken.set(jobToken, updated);
    return clone(updated);
  }

  async failJob(jobToken: string, error: string): Promise<JobRecord> {
    const existing = this.jobsByToken.get(jobToken);
    if (!existing) {
      throw new Error(`Job not found: ${jobToken}`);
    }

    const updated: JobRecord = {
      ...existing,
      status: "failed",
      errorMessage: error,
      updatedAt: timestamp()
    };

    this.jobsByToken.set(jobToken, updated);
    return clone(updated);
  }

  async createAccessGrant(input: {
    resourceType: ResourceType;
    resourceId: string;
    wallet: string;
    paymentId: string;
    metadata?: Record<string, unknown>;
  }): Promise<AccessGrantRecord> {
    const key = `${input.resourceType}:${input.resourceId}:${input.wallet}`;
    const existing = this.accessGrants.get(key);
    if (existing) {
      return clone(existing);
    }

    const record: AccessGrantRecord = {
      id: randomUUID(),
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      wallet: input.wallet,
      paymentId: input.paymentId,
      metadata: clone(input.metadata ?? {}),
      createdAt: timestamp()
    };

    this.accessGrants.set(key, record);
    return clone(record);
  }

  async getAccessGrant(resourceType: ResourceType, resourceId: string, wallet: string): Promise<AccessGrantRecord | null> {
    return clone(this.accessGrants.get(`${resourceType}:${resourceId}:${wallet}`) ?? null);
  }

  async recordProviderAttempt(input: {
    jobToken: string;
    phase: "execute" | "poll" | "refund";
    status: "succeeded" | "failed";
    requestPayload?: unknown;
    responsePayload?: unknown;
    errorMessage?: string;
  }): Promise<ProviderAttemptRecord> {
    const record: ProviderAttemptRecord = {
      id: randomUUID(),
      jobToken: input.jobToken,
      phase: input.phase,
      status: input.status,
      requestPayload: clone(input.requestPayload ?? null),
      responsePayload: clone(input.responsePayload ?? null),
      errorMessage: input.errorMessage ?? null,
      createdAt: timestamp()
    };

    this.attempts.push(record);
    return clone(record);
  }

  async createRefund(input: {
    jobToken: string;
    paymentId: string;
    wallet: string;
    amount: string;
  }): Promise<RefundRecord> {
    const existing = this.refundsByJobToken.get(input.jobToken);
    if (existing) {
      return clone(existing);
    }

    const record: RefundRecord = {
      id: randomUUID(),
      jobToken: input.jobToken,
      paymentId: input.paymentId,
      wallet: input.wallet,
      amount: input.amount,
      status: "pending",
      txHash: null,
      errorMessage: null,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };

    this.refundsById.set(record.id, record);
    this.refundsByJobToken.set(record.jobToken, record);

    const job = this.jobsByToken.get(input.jobToken);
    if (job) {
      this.jobsByToken.set(input.jobToken, {
        ...job,
        refundStatus: "pending",
        refundId: record.id,
        updatedAt: timestamp()
      });
    }

    return clone(record);
  }

  async markRefundSent(refundId: string, txHash: string): Promise<RefundRecord> {
    const existing = this.refundsById.get(refundId);
    if (!existing) {
      throw new Error(`Refund not found: ${refundId}`);
    }

    const updated: RefundRecord = {
      ...existing,
      status: "sent",
      txHash,
      errorMessage: null,
      updatedAt: timestamp()
    };

    this.refundsById.set(refundId, updated);
    this.refundsByJobToken.set(updated.jobToken, updated);

    const job = this.jobsByToken.get(updated.jobToken);
    if (job) {
      this.jobsByToken.set(updated.jobToken, {
        ...job,
        refundStatus: "sent",
        refundId: refundId,
        updatedAt: timestamp()
      });
    }

    return clone(updated);
  }

  async markRefundFailed(refundId: string, errorMessage: string): Promise<RefundRecord> {
    const existing = this.refundsById.get(refundId);
    if (!existing) {
      throw new Error(`Refund not found: ${refundId}`);
    }

    const updated: RefundRecord = {
      ...existing,
      status: "failed",
      errorMessage,
      updatedAt: timestamp()
    };

    this.refundsById.set(refundId, updated);
    this.refundsByJobToken.set(updated.jobToken, updated);

    const job = this.jobsByToken.get(updated.jobToken);
    if (job) {
      this.jobsByToken.set(updated.jobToken, {
        ...job,
        refundStatus: "failed",
        refundId,
        updatedAt: timestamp()
      });
    }

    return clone(updated);
  }

  async getRefundByJobToken(jobToken: string): Promise<RefundRecord | null> {
    return clone(this.refundsByJobToken.get(jobToken) ?? null);
  }

  async getServiceAnalytics(routeIds: string[]): Promise<ServiceAnalytics> {
    return computeServiceAnalytics({
      routeIds,
      idempotencyRecords: Array.from(this.idempotencyByPaymentId.values()),
      jobs: Array.from(this.jobsByToken.values())
    });
  }

  async createSuggestion(input: CreateSuggestionInput): Promise<SuggestionRecord> {
    const now = timestamp();
    const record: SuggestionRecord = {
      id: randomUUID(),
      type: input.type,
      serviceSlug: input.serviceSlug ?? null,
      title: input.title,
      description: input.description,
      sourceUrl: input.sourceUrl ?? null,
      requesterName: input.requesterName ?? null,
      requesterEmail: input.requesterEmail ?? null,
      status: "submitted",
      internalNotes: null,
      createdAt: now,
      updatedAt: now
    };

    this.suggestionsById.set(record.id, record);
    return clone(record);
  }

  async listSuggestions(filter?: { status?: SuggestionStatus }): Promise<SuggestionRecord[]> {
    const suggestions = Array.from(this.suggestionsById.values())
      .filter((suggestion) => !filter?.status || suggestion.status === filter.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return clone(suggestions);
  }

  async updateSuggestion(id: string, input: UpdateSuggestionInput): Promise<SuggestionRecord | null> {
    const existing = this.suggestionsById.get(id);
    if (!existing) {
      return null;
    }

    const updated: SuggestionRecord = {
      ...existing,
      status: input.status ?? existing.status,
      internalNotes: input.internalNotes === undefined ? existing.internalNotes : input.internalNotes,
      updatedAt: timestamp()
    };

    this.suggestionsById.set(id, updated);
    return clone(updated);
  }
}

export class PostgresMarketplaceStore implements MarketplaceStore {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS idempotency_records (
        payment_id TEXT PRIMARY KEY,
        normalized_request_hash TEXT NOT NULL,
        buyer_wallet TEXT NOT NULL,
        route_id TEXT NOT NULL,
        route_version TEXT NOT NULL,
        quoted_price TEXT NOT NULL,
        payout_split JSONB NOT NULL DEFAULT '{}'::jsonb,
        payment_payload TEXT NOT NULL,
        facilitator_response JSONB NOT NULL,
        response_kind TEXT NOT NULL,
        response_status_code INTEGER NOT NULL,
        response_body JSONB NOT NULL,
        response_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
        job_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS jobs (
        job_token TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL REFERENCES idempotency_records(payment_id),
        route_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        operation TEXT NOT NULL,
        buyer_wallet TEXT NOT NULL,
        quoted_price TEXT NOT NULL,
        payout_split JSONB NOT NULL DEFAULT '{}'::jsonb,
        provider_job_id TEXT NOT NULL,
        request_body JSONB NOT NULL,
        provider_state JSONB,
        status TEXT NOT NULL,
        result_body JSONB,
        error_message TEXT,
        refund_status TEXT NOT NULL DEFAULT 'not_required',
        refund_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS provider_attempts (
        id TEXT PRIMARY KEY,
        job_token TEXT NOT NULL REFERENCES jobs(job_token),
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        request_payload JSONB,
        response_payload JSONB,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS access_grants (
        id TEXT PRIMARY KEY,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        payment_id TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(resource_type, resource_id, wallet)
      );

      CREATE TABLE IF NOT EXISTS refunds (
        id TEXT PRIMARY KEY,
        job_token TEXT UNIQUE NOT NULL REFERENCES jobs(job_token),
        payment_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS service_suggestions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        service_slug TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        source_url TEXT,
        requester_name TEXT,
        requester_email TEXT,
        status TEXT NOT NULL,
        internal_notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE idempotency_records
      ADD COLUMN IF NOT EXISTS payout_split JSONB NOT NULL DEFAULT '{}'::jsonb;

      ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS payout_split JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
  }

  async getIdempotencyByPaymentId(paymentId: string): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query("SELECT * FROM idempotency_records WHERE payment_id = $1", [paymentId]);
    return result.rowCount ? mapIdempotencyRow(result.rows[0]) : null;
  }

  async saveSyncIdempotency(input: SaveSyncIdempotencyInput): Promise<IdempotencyRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO idempotency_records (
        payment_id, normalized_request_hash, buyer_wallet, route_id, route_version,
        quoted_price, payout_split, payment_payload, facilitator_response, response_kind,
        response_status_code, response_body, response_headers
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, 'sync', $10, $11::jsonb, $12::jsonb)
      RETURNING *
      `,
      [
        input.paymentId,
        input.normalizedRequestHash,
        input.buyerWallet,
        input.routeId,
        input.routeVersion,
        input.quotedPrice,
        JSON.stringify(input.payoutSplit),
        input.paymentPayload,
        JSON.stringify(input.facilitatorResponse),
        input.statusCode,
        JSON.stringify(input.body),
        JSON.stringify(input.headers ?? {})
      ]
    );

    return mapIdempotencyRow(result.rows[0]);
  }

  async saveAsyncAcceptance(input: SaveAsyncAcceptanceInput): Promise<{ idempotency: IdempotencyRecord; job: JobRecord }> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const idempotencyResult = await client.query(
        `
        INSERT INTO idempotency_records (
          payment_id, normalized_request_hash, buyer_wallet, route_id, route_version,
          quoted_price, payout_split, payment_payload, facilitator_response, response_kind,
          response_status_code, response_body, response_headers, job_token
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, 'job', 202, $10::jsonb, $11::jsonb, $12)
        RETURNING *
        `,
        [
          input.paymentId,
          input.normalizedRequestHash,
          input.buyerWallet,
          input.route.routeId,
          input.route.version,
          input.quotedPrice,
          JSON.stringify(input.payoutSplit),
          input.paymentPayload,
          JSON.stringify(input.facilitatorResponse),
          JSON.stringify(input.responseBody),
          JSON.stringify(input.responseHeaders ?? {}),
          input.jobToken
        ]
      );

      const jobResult = await client.query(
        `
        INSERT INTO jobs (
          job_token, payment_id, route_id, provider, operation, buyer_wallet, quoted_price,
          payout_split, provider_job_id, request_body, provider_state, status, result_body, error_message,
          refund_status, refund_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, 'pending', NULL, NULL, 'not_required', NULL)
        RETURNING *
        `,
        [
          input.jobToken,
          input.paymentId,
          input.route.routeId,
          input.route.provider,
          input.route.operation,
          input.buyerWallet,
          input.quotedPrice,
          JSON.stringify(input.payoutSplit),
          input.providerJobId,
          JSON.stringify(input.requestBody),
          JSON.stringify(input.providerState ?? null)
        ]
      );

      await client.query("COMMIT");
      return {
        idempotency: mapIdempotencyRow(idempotencyResult.rows[0]),
        job: mapJobRow(jobResult.rows[0])
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getJob(jobToken: string): Promise<JobRecord | null> {
    const result = await this.pool.query("SELECT * FROM jobs WHERE job_token = $1", [jobToken]);
    return result.rowCount ? mapJobRow(result.rows[0]) : null;
  }

  async listPendingJobs(limit: number): Promise<JobRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapJobRow);
  }

  async updateJobPending(jobToken: string, providerState?: Record<string, unknown>): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      UPDATE jobs
      SET provider_state = $2::jsonb, updated_at = NOW()
      WHERE job_token = $1
      RETURNING *
      `,
      [jobToken, JSON.stringify(providerState ?? null)]
    );

    return mapJobRow(result.rows[0]);
  }

  async completeJob(jobToken: string, body: unknown): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      UPDATE jobs
      SET status = 'completed', result_body = $2::jsonb, error_message = NULL, updated_at = NOW()
      WHERE job_token = $1
      RETURNING *
      `,
      [jobToken, JSON.stringify(body)]
    );

    return mapJobRow(result.rows[0]);
  }

  async failJob(jobToken: string, error: string): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      UPDATE jobs
      SET status = 'failed', error_message = $2, updated_at = NOW()
      WHERE job_token = $1
      RETURNING *
      `,
      [jobToken, error]
    );

    return mapJobRow(result.rows[0]);
  }

  async createAccessGrant(input: {
    resourceType: ResourceType;
    resourceId: string;
    wallet: string;
    paymentId: string;
    metadata?: Record<string, unknown>;
  }): Promise<AccessGrantRecord> {
    const existing = await this.getAccessGrant(input.resourceType, input.resourceId, input.wallet);
    if (existing) {
      return existing;
    }

    const result = await this.pool.query(
      `
      INSERT INTO access_grants (id, resource_type, resource_id, wallet, payment_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING *
      `,
      [randomUUID(), input.resourceType, input.resourceId, input.wallet, input.paymentId, JSON.stringify(input.metadata ?? {})]
    );

    return mapAccessGrantRow(result.rows[0]);
  }

  async getAccessGrant(resourceType: ResourceType, resourceId: string, wallet: string): Promise<AccessGrantRecord | null> {
    const result = await this.pool.query(
      `
      SELECT * FROM access_grants
      WHERE resource_type = $1 AND resource_id = $2 AND wallet = $3
      `,
      [resourceType, resourceId, wallet]
    );
    return result.rowCount ? mapAccessGrantRow(result.rows[0]) : null;
  }

  async recordProviderAttempt(input: {
    jobToken: string;
    phase: "execute" | "poll" | "refund";
    status: "succeeded" | "failed";
    requestPayload?: unknown;
    responsePayload?: unknown;
    errorMessage?: string;
  }): Promise<ProviderAttemptRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO provider_attempts (id, job_token, phase, status, request_payload, response_payload, error_message)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
      RETURNING *
      `,
      [
        randomUUID(),
        input.jobToken,
        input.phase,
        input.status,
        JSON.stringify(input.requestPayload ?? null),
        JSON.stringify(input.responsePayload ?? null),
        input.errorMessage ?? null
      ]
    );

    return mapAttemptRow(result.rows[0]);
  }

  async createRefund(input: {
    jobToken: string;
    paymentId: string;
    wallet: string;
    amount: string;
  }): Promise<RefundRecord> {
    const existing = await this.getRefundByJobToken(input.jobToken);
    if (existing) {
      return existing;
    }

    const result = await this.pool.query(
      `
      INSERT INTO refunds (id, job_token, payment_id, wallet, amount, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *
      `,
      [randomUUID(), input.jobToken, input.paymentId, input.wallet, input.amount]
    );

    const refund = mapRefundRow(result.rows[0]);
    await this.pool.query(
      `
      UPDATE jobs
      SET refund_status = 'pending', refund_id = $2, updated_at = NOW()
      WHERE job_token = $1
      `,
      [input.jobToken, refund.id]
    );

    return refund;
  }

  async markRefundSent(refundId: string, txHash: string): Promise<RefundRecord> {
    const result = await this.pool.query(
      `
      UPDATE refunds
      SET status = 'sent', tx_hash = $2, error_message = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [refundId, txHash]
    );

    const refund = mapRefundRow(result.rows[0]);
    await this.pool.query(
      `
      UPDATE jobs
      SET refund_status = 'sent', refund_id = $2, updated_at = NOW()
      WHERE job_token = $1
      `,
      [refund.jobToken, refund.id]
    );

    return refund;
  }

  async markRefundFailed(refundId: string, errorMessage: string): Promise<RefundRecord> {
    const result = await this.pool.query(
      `
      UPDATE refunds
      SET status = 'failed', error_message = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [refundId, errorMessage]
    );

    const refund = mapRefundRow(result.rows[0]);
    await this.pool.query(
      `
      UPDATE jobs
      SET refund_status = 'failed', refund_id = $2, updated_at = NOW()
      WHERE job_token = $1
      `,
      [refund.jobToken, refund.id]
    );

    return refund;
  }

  async getRefundByJobToken(jobToken: string): Promise<RefundRecord | null> {
    const result = await this.pool.query("SELECT * FROM refunds WHERE job_token = $1", [jobToken]);
    return result.rowCount ? mapRefundRow(result.rows[0]) : null;
  }

  async getServiceAnalytics(routeIds: string[]): Promise<ServiceAnalytics> {
    const [idempotencyResult, jobsResult] = await Promise.all([
      this.pool.query(
        `
        SELECT * FROM idempotency_records
        WHERE route_id = ANY($1::text[])
        `,
        [routeIds]
      ),
      this.pool.query(
        `
        SELECT * FROM jobs
        WHERE route_id = ANY($1::text[])
        `,
        [routeIds]
      )
    ]);

    return computeServiceAnalytics({
      routeIds,
      idempotencyRecords: idempotencyResult.rows.map(mapIdempotencyRow),
      jobs: jobsResult.rows.map(mapJobRow)
    });
  }

  async createSuggestion(input: CreateSuggestionInput): Promise<SuggestionRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO service_suggestions (
        id, type, service_slug, title, description, source_url, requester_name, requester_email, status, internal_notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted', NULL)
      RETURNING *
      `,
      [
        randomUUID(),
        input.type,
        input.serviceSlug ?? null,
        input.title,
        input.description,
        input.sourceUrl ?? null,
        input.requesterName ?? null,
        input.requesterEmail ?? null
      ]
    );

    return mapSuggestionRow(result.rows[0]);
  }

  async listSuggestions(filter?: { status?: SuggestionStatus }): Promise<SuggestionRecord[]> {
    const hasStatus = Boolean(filter?.status);
    const result = await this.pool.query(
      `
      SELECT * FROM service_suggestions
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC
      `,
      [hasStatus ? filter?.status ?? null : null]
    );

    return result.rows.map(mapSuggestionRow);
  }

  async updateSuggestion(id: string, input: UpdateSuggestionInput): Promise<SuggestionRecord | null> {
    const result = await this.pool.query(
      `
      UPDATE service_suggestions
      SET
        status = COALESCE($2, status),
        internal_notes = CASE
          WHEN $3::boolean THEN $4
          ELSE internal_notes
        END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        id,
        input.status ?? null,
        input.internalNotes !== undefined,
        input.internalNotes ?? null
      ]
    );

    return result.rowCount ? mapSuggestionRow(result.rows[0]) : null;
  }
}

function mapIdempotencyRow(row: Record<string, unknown>): IdempotencyRecord {
  return {
    paymentId: row.payment_id as string,
    normalizedRequestHash: row.normalized_request_hash as string,
    buyerWallet: row.buyer_wallet as string,
    routeId: row.route_id as string,
    routeVersion: row.route_version as string,
    quotedPrice: row.quoted_price as string,
    payoutSplit: row.payout_split as IdempotencyRecord["payoutSplit"],
    paymentPayload: row.payment_payload as string,
    facilitatorResponse: row.facilitator_response,
    responseKind: row.response_kind as "sync" | "job",
    responseStatusCode: row.response_status_code as number,
    responseBody: row.response_body,
    responseHeaders: (row.response_headers as Record<string, string>) ?? {},
    jobToken: (row.job_token as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapJobRow(row: Record<string, unknown>): JobRecord {
  return {
    jobToken: row.job_token as string,
    paymentId: row.payment_id as string,
    routeId: row.route_id as string,
    provider: row.provider as string,
    operation: row.operation as string,
    buyerWallet: row.buyer_wallet as string,
    quotedPrice: row.quoted_price as string,
    payoutSplit: row.payout_split as JobRecord["payoutSplit"],
    providerJobId: row.provider_job_id as string,
    requestBody: row.request_body,
    providerState: (row.provider_state as Record<string, unknown> | null) ?? null,
    status: row.status as JobRecord["status"],
    resultBody: row.result_body,
    errorMessage: (row.error_message as string | null) ?? null,
    refundStatus: row.refund_status as JobRecord["refundStatus"],
    refundId: (row.refund_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapAttemptRow(row: Record<string, unknown>): ProviderAttemptRecord {
  return {
    id: row.id as string,
    jobToken: row.job_token as string,
    phase: row.phase as ProviderAttemptRecord["phase"],
    status: row.status as ProviderAttemptRecord["status"],
    requestPayload: row.request_payload,
    responsePayload: row.response_payload,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString()
  };
}

function mapAccessGrantRow(row: Record<string, unknown>): AccessGrantRecord {
  return {
    id: row.id as string,
    resourceType: row.resource_type as "job",
    resourceId: row.resource_id as string,
    wallet: row.wallet as string,
    paymentId: row.payment_id as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(row.created_at as string | Date).toISOString()
  };
}

function mapRefundRow(row: Record<string, unknown>): RefundRecord {
  return {
    id: row.id as string,
    jobToken: row.job_token as string,
    paymentId: row.payment_id as string,
    wallet: row.wallet as string,
    amount: row.amount as string,
    status: row.status as RefundRecord["status"],
    txHash: (row.tx_hash as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapSuggestionRow(row: Record<string, unknown>): SuggestionRecord {
  return {
    id: row.id as string,
    type: row.type as SuggestionRecord["type"],
    serviceSlug: (row.service_slug as string | null) ?? null,
    title: row.title as string,
    description: row.description as string,
    sourceUrl: (row.source_url as string | null) ?? null,
    requesterName: (row.requester_name as string | null) ?? null,
    requesterEmail: (row.requester_email as string | null) ?? null,
    status: row.status as SuggestionRecord["status"],
    internalNotes: (row.internal_notes as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function computeServiceAnalytics(input: {
  routeIds: string[];
  idempotencyRecords: IdempotencyRecord[];
  jobs: JobRecord[];
}): ServiceAnalytics {
  const routeIds = new Set(input.routeIds);
  const acceptedCalls = input.idempotencyRecords.filter((record) => routeIds.has(record.routeId));
  const jobs = input.jobs.filter((job) => routeIds.has(job.routeId));
  const windowStart = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
  const volumeMap = new Map<string, bigint>();

  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    volumeMap.set(date, 0n);
  }

  let resolvedCalls30d = 0;
  let successfulCalls30d = 0;
  let revenueRaw = 0n;

  for (const record of acceptedCalls) {
    const createdAt = new Date(record.createdAt);
    if (createdAt >= windowStart) {
      const dateKey = createdAt.toISOString().slice(0, 10);
      volumeMap.set(dateKey, (volumeMap.get(dateKey) ?? 0n) + BigInt(record.quotedPrice));
    }

    if (record.responseKind === "sync") {
      const wasSuccessful = record.responseStatusCode >= 200 && record.responseStatusCode < 400;
      if (wasSuccessful) {
        revenueRaw += BigInt(record.payoutSplit.providerAmount);
      }

      if (createdAt >= windowStart) {
        resolvedCalls30d += 1;
        if (wasSuccessful) {
          successfulCalls30d += 1;
        }
      }
    }
  }

  for (const job of jobs) {
    const createdAt = new Date(job.createdAt);
    if (job.status === "completed") {
      revenueRaw += BigInt(job.payoutSplit.providerAmount);
    }

    if (createdAt < windowStart || job.status === "pending") {
      continue;
    }

    resolvedCalls30d += 1;
    if (job.status === "completed") {
      successfulCalls30d += 1;
    }
  }

  return {
    totalCalls: acceptedCalls.length,
    revenueRaw: revenueRaw.toString(),
    successRate30d: resolvedCalls30d === 0 ? 0 : (successfulCalls30d / resolvedCalls30d) * 100,
    volume30d: Array.from(volumeMap.entries()).map(([date, amountRaw]) => ({
      date,
      amountRaw: amountRaw.toString()
    }))
  };
}
