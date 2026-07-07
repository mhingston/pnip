import { Kysely } from "kysely";
import type { Database } from "../../database/kysely.js";

export type EmailDeliveryStatus = "pending" | "sent" | "failed";

export interface EmailDigestRow {
  id: string;
  edition_id: string;
  subject: string;
  html_content: string;
  text_content: string;
  from_address: string;
  to_addresses: unknown;
  provider_kind: string;
  delivery_status: string;
  attempt_count: number;
  provider_response: unknown | null;
  provider_message_id: string | null;
  failure_reason: string | null;
  attempted_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export interface CreateEmailDigestInput {
  editionId: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  fromAddress: string;
  toAddresses: string[];
  deliveryStatus?: "pending" | "sent" | "failed";
  attemptCount?: number;
  providerResponse?: unknown;
  providerMessageId?: string | null;
  failureReason?: string | null;
  attemptedAt?: Date | null;
  completedAt?: Date | null;
}

export interface UpdateEmailDigestInput {
  deliveryStatus: "pending" | "sent" | "failed";
  attemptCount: number;
  providerResponse: unknown | null;
  providerMessageId: string | null;
  failureReason: string | null;
  attemptedAt: Date;
  completedAt: Date | null;
}

export interface EmailDigestRepository {
  createForEdition(input: CreateEmailDigestInput): Promise<EmailDigestRow>;
  getByEdition(editionId: string): Promise<EmailDigestRow | undefined>;
  updateDelivery(
    id: string,
    update: UpdateEmailDigestInput,
  ): Promise<EmailDigestRow>;
  deleteByEdition(editionId: string): Promise<void>;
}

export class EmailDigestConflictError extends Error {
  readonly editionId: string;
  constructor(editionId: string) {
    super(`email digest already exists for edition ${editionId}`);
    this.name = "EmailDigestConflictError";
    this.editionId = editionId;
  }
}

export function createEmailDigestRepository(
  db: Kysely<Database>,
): EmailDigestRepository {
  return {
    async createForEdition(input) {
      try {
        return await db
          .insertInto("email_digests")
          .values({
            edition_id: input.editionId,
            subject: input.subject,
            html_content: input.htmlContent,
            text_content: input.textContent,
            from_address: input.fromAddress,
            to_addresses: JSON.stringify(input.toAddresses),
            delivery_status: input.deliveryStatus ?? "pending",
            attempt_count: input.attemptCount ?? 0,
            provider_response: input.providerResponse === undefined
              ? null
              : JSON.stringify(input.providerResponse),
            provider_message_id: input.providerMessageId ?? null,
            failure_reason: input.failureReason ?? null,
            attempted_at: input.attemptedAt ?? null,
            completed_at: input.completedAt ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new EmailDigestConflictError(input.editionId);
        }
        throw err;
      }
    },

    async getByEdition(editionId) {
      return db
        .selectFrom("email_digests")
        .selectAll()
        .where("edition_id", "=", editionId)
        .executeTakeFirst();
    },

    async updateDelivery(id, update) {
      const row = await db
        .updateTable("email_digests")
        .set({
          delivery_status: update.deliveryStatus,
          attempt_count: update.attemptCount,
          provider_response:
            update.providerResponse === null
              ? null
              : JSON.stringify(update.providerResponse),
          provider_message_id: update.providerMessageId,
          failure_reason: update.failureReason,
          attempted_at: update.attemptedAt,
          completed_at: update.completedAt,
        })
        .where("id", "=", id)
        .where("delivery_status", "<>", update.deliveryStatus)
        .returningAll()
        .executeTakeFirst();

      if (row) return row;

      // Already in the requested status (e.g., a concurrent retry observed
      // the same outcome). Read the latest row so the caller sees the
      // persisted state.
      const current = await db
        .selectFrom("email_digests")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!current) {
        throw new Error(`email digest row disappeared during update: ${id}`);
      }
      return current;
    },

    async deleteByEdition(editionId) {
      await db
        .deleteFrom("email_digests")
        .where("edition_id", "=", editionId)
        .execute();
    },
  };
}

interface DatabaseErrorLike {
  code?: string;
  constraint?: string;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as DatabaseErrorLike;
  return e?.code === "23505";
}
