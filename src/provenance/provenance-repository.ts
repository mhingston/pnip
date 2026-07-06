import { Kysely, sql } from "kysely";
import type { Database, LineageEdge, EntityRef } from "../database/kysely.js";

export type { LineageEdge, EntityRef } from "../database/kysely.js";

export interface LineageEdgeInput {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relation: string;
  metadata?: unknown;
}

export interface ProvenanceRepository {
  recordLineage(edge: LineageEdgeInput): Promise<void>;
  recordLineageBatch(edges: LineageEdgeInput[]): Promise<void>;
  getSources(entity: EntityRef): Promise<LineageEdge[]>;
  getConsumers(entity: EntityRef): Promise<LineageEdge[]>;
  resolveCitations(artifactId: string): Promise<string[]>;
  resolveToDocuments(entity: EntityRef): Promise<string[]>;
}

const EDGE_COLUMNS = [
  "source_type",
  "source_id",
  "target_type",
  "target_id",
  "relation",
] as const;

function toMetadata(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function toRow(input: LineageEdgeInput) {
  return {
    source_type: input.sourceType,
    source_id: input.sourceId,
    target_type: input.targetType,
    target_id: input.targetId,
    relation: input.relation,
    metadata: toMetadata(input.metadata),
  };
}

export function createProvenanceRepository(
  db: Kysely<Database>,
): ProvenanceRepository {
  return {
    async recordLineage(input: LineageEdgeInput): Promise<void> {
      await db
        .insertInto("document_lineage")
        .values(toRow(input))
        .onConflict((oc) => oc.columns([...EDGE_COLUMNS]).doNothing())
        .execute();
    },

    async recordLineageBatch(edges: LineageEdgeInput[]): Promise<void> {
      if (edges.length === 0) return;
      await db
        .insertInto("document_lineage")
        .values(edges.map(toRow))
        .onConflict((oc) => oc.columns([...EDGE_COLUMNS]).doNothing())
        .execute();
    },

    async getSources(entity: EntityRef): Promise<LineageEdge[]> {
      return db
        .selectFrom("document_lineage")
        .selectAll()
        .where("source_type", "=", entity.type)
        .where("source_id", "=", entity.id)
        .execute();
    },

    async getConsumers(entity: EntityRef): Promise<LineageEdge[]> {
      return db
        .selectFrom("document_lineage")
        .selectAll()
        .where("target_type", "=", entity.type)
        .where("target_id", "=", entity.id)
        .execute();
    },

    async resolveCitations(artifactId: string): Promise<string[]> {
      const rows = await db
        .selectFrom("document_lineage")
        .select("target_id")
        .where("source_type", "=", "artifact")
        .where("source_id", "=", artifactId)
        .where("relation", "in", ["cite", "supports"])
        .where("target_type", "=", "chunk")
        .distinct()
        .execute();
      return rows.map((r) => r.target_id);
    },

    async resolveToDocuments(entity: EntityRef): Promise<string[]> {
      const result = await sql<{ target_id: string }>`
        WITH RECURSIVE walk AS (
          SELECT source_type, source_id, target_type, target_id, relation, 0 AS depth
          FROM document_lineage
          WHERE source_type = ${entity.type} AND source_id = ${entity.id}
          UNION ALL
          SELECT e.source_type, e.source_id, e.target_type, e.target_id, e.relation, w.depth + 1
          FROM document_lineage e
          JOIN walk w ON e.source_type = w.target_type AND e.source_id = w.target_id
          WHERE w.depth < 100
        )
        SELECT DISTINCT target_id FROM walk WHERE target_type = 'document'
      `.execute(db);
      return result.rows.map((r) => r.target_id);
    },
  };
}
