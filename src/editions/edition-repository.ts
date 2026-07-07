import { Kysely, sql, type RawBuilder, type SqlBool } from "kysely";
import type { Database, Edition, EditionStatus } from "../database/kysely.js";

export const EDITION_TRANSITIONS: Record<EditionStatus, EditionStatus[]> = {
  building: ["ready", "failed"],
  ready: ["publishing", "failed"],
  publishing: ["published", "failed"],
  failed: ["building"],
  published: [],
};

export class EditionNotFoundError extends Error {
  readonly editionId: string;
  constructor(editionId: string) {
    super(`Edition not found: ${editionId}`);
    this.name = "EditionNotFoundError";
    this.editionId = editionId;
  }
}

export class InvalidEditionTransitionError extends Error {
  readonly from: EditionStatus;
  readonly to: EditionStatus;
  constructor(from: EditionStatus, to: EditionStatus) {
    super(`Invalid edition transition: ${from} → ${to}`);
    this.name = "InvalidEditionTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class EditionConcurrentUpdateError extends Error {
  readonly editionId: string;
  constructor(editionId: string) {
    super(`Concurrent update detected for edition ${editionId}`);
    this.name = "EditionConcurrentUpdateError";
    this.editionId = editionId;
  }
}

export class EditionProcessingNotAllowedError extends Error {
  readonly editionId: string;
  readonly status: EditionStatus;
  constructor(editionId: string, status: EditionStatus) {
    super(
      `edition ${editionId} is in status '${status}'; document processing is not allowed`,
    );
    this.name = "EditionProcessingNotAllowedError";
    this.editionId = editionId;
    this.status = status;
  }
}

export const MUTABLE_FOR_PROCESSING_STATUSES: readonly EditionStatus[] = [
  "building",
  "failed",
] as const;

export interface EditionRepository {
  create(publicationDate: string | Date): Promise<Edition>;
  getById(id: string): Promise<Edition | undefined>;
  getByDate(publicationDate: string | Date): Promise<Edition | undefined>;
  getOrCreateForDate(publicationDate: string | Date): Promise<Edition>;
  transition(
    id: string,
    to: EditionStatus,
    opts?: { failureReason?: string },
  ): Promise<Edition>;
  isProcessingAllowed(id: string): Promise<boolean>;
  assertProcessingAllowed(id: string): Promise<Edition>;
}

function asDateColumn(value: string | Date): RawBuilder<Date> {
  return sql<Date>`${value}::date`;
}

export function createEditionRepository(db: Kysely<Database>): EditionRepository {
  return {
    async create(publicationDate: string | Date): Promise<Edition> {
      return db
        .insertInto("editions")
        .values({ publication_date: asDateColumn(publicationDate) })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async getById(id: string): Promise<Edition | undefined> {
      return db
        .selectFrom("editions")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    },

    async getByDate(publicationDate: string | Date): Promise<Edition | undefined> {
      return db
        .selectFrom("editions")
        .selectAll()
        .where(sql<SqlBool>`publication_date = ${asDateColumn(publicationDate)}`)
        .executeTakeFirst();
    },

    async getOrCreateForDate(publicationDate: string | Date): Promise<Edition> {
      return db.transaction().execute(async (trx) => {
        await trx
          .insertInto("editions")
          .values({ publication_date: asDateColumn(publicationDate) })
          .onConflict((oc) => oc.column("publication_date").doNothing())
          .execute();
        return trx
          .selectFrom("editions")
          .selectAll()
          .where(sql<SqlBool>`publication_date = ${asDateColumn(publicationDate)}`)
          .executeTakeFirstOrThrow();
      });
    },

    async transition(
      id: string,
      to: EditionStatus,
      opts?: { failureReason?: string },
    ): Promise<Edition> {
      return db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom("editions")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();
        if (!current) throw new EditionNotFoundError(id);
        if (!EDITION_TRANSITIONS[current.status].includes(to)) {
          throw new InvalidEditionTransitionError(current.status, to);
        }
        const updated = await trx
          .updateTable("editions")
          .set({
            status: to,
            updated_at: sql`now()`,
            ...(to === "published" ? { published_at: sql`now()` } : {}),
            ...(to === "failed"
              ? {
                  failed_at: sql`now()`,
                  failure_reason: opts?.failureReason ?? null,
                }
              : {}),
          })
          .where("id", "=", id)
          .where("status", "=", current.status)
          .returningAll()
          .execute();
        if (updated.length === 0) {
          throw new EditionConcurrentUpdateError(id);
        }
        return updated[0];
      });
    },

    async isProcessingAllowed(id: string): Promise<boolean> {
      const row = await db
        .selectFrom("editions")
        .select(["status"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return false;
      return (MUTABLE_FOR_PROCESSING_STATUSES as readonly EditionStatus[]).includes(
        row.status,
      );
    },

    async assertProcessingAllowed(id: string): Promise<Edition> {
      const edition = await this.getById(id);
      if (!edition) throw new EditionNotFoundError(id);
      if (
        !(MUTABLE_FOR_PROCESSING_STATUSES as readonly EditionStatus[]).includes(
          edition.status,
        )
      ) {
        throw new EditionProcessingNotAllowedError(id, edition.status);
      }
      return edition;
    },
  };
}
