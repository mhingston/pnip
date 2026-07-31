import { describe, expect, it } from "vitest";
import { EditorialPlanSchema } from "./editorial-plan-schema.js";
import { validateEditorialPlan } from "./editorial-plan-validator.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const plan = (stories: unknown[]) => EditorialPlanSchema.parse({ stories });

describe("editorial plan validation", () => {
  it("requires complete, disjoint corpus accounting", () => {
    const errors = validateEditorialPlan({
      plan: plan([{ key: "a", title: "A", documentIds: [A, B], leadDocumentId: A, importance: 1, mergeReason: "same_event" }]),
      documentIds: [A, B],
    });
    expect(errors).toEqual([]);
  });

  it("rejects duplicate, unknown, missing, and invalid lead references", () => {
    const C = "00000000-0000-4000-8000-000000000003";
    const errors = validateEditorialPlan({
      plan: plan([
        { key: "a", title: "A", documentIds: [A, C], leadDocumentId: B, importance: 1, mergeReason: "singleton" },
        { key: "a", title: "A2", documentIds: [A], leadDocumentId: A, importance: 0, mergeReason: "singleton" },
      ]),
      documentIds: [A, B],
    });
    expect(errors.map((e) => e.code)).toEqual(expect.arrayContaining(["unknown_document", "duplicate_document", "missing_document", "invalid_lead", "duplicate_story_key"]));
  });
});
