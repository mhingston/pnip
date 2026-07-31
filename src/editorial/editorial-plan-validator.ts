import type { EditorialPlan } from "./editorial-plan-schema.js";

export interface EditorialPlanValidationError {
  code: "unknown_document" | "duplicate_document" | "missing_document" | "invalid_lead" | "duplicate_story_key" | "empty_title" | "input_changed";
  message: string;
  documentId?: string;
  storyKey?: string;
}

export function validateEditorialPlan(input: {
  plan: EditorialPlan;
  documentIds: readonly string[];
  inputChanged?: boolean;
}): EditorialPlanValidationError[] {
  const errors: EditorialPlanValidationError[] = [];
  const known = new Set(input.documentIds);
  const seenDocuments = new Map<string, string>();
  const keys = new Set<string>();
  if (input.inputChanged) errors.push({ code: "input_changed", message: "edition composition input changed while the plan was being generated" });
  for (const story of input.plan.stories) {
    if (keys.has(story.key)) errors.push({ code: "duplicate_story_key", message: `duplicate story key '${story.key}'`, storyKey: story.key });
    keys.add(story.key);
    if (story.title.trim() === "") errors.push({ code: "empty_title", message: "story title is empty", storyKey: story.key });
    if (!story.documentIds.includes(story.leadDocumentId)) errors.push({ code: "invalid_lead", message: "lead document is not a member of the story", storyKey: story.key, documentId: story.leadDocumentId });
    for (const documentId of story.documentIds) {
      if (!known.has(documentId)) errors.push({ code: "unknown_document", message: `unknown document '${documentId}'`, storyKey: story.key, documentId });
      const prior = seenDocuments.get(documentId);
      if (prior) errors.push({ code: "duplicate_document", message: `document appears in stories '${prior}' and '${story.key}'`, storyKey: story.key, documentId });
      seenDocuments.set(documentId, story.key);
    }
  }
  for (const documentId of known) if (!seenDocuments.has(documentId)) errors.push({ code: "missing_document", message: `document '${documentId}' is not assigned to a story`, documentId });
  return errors;
}
