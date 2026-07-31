import { z } from "zod";

export const EditorialPlanSchema = z.object({
  stories: z.array(z.object({
    key: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(160),
    documentIds: z.array(z.string().uuid()).min(1),
    leadDocumentId: z.string().uuid(),
    importance: z.number().min(0).max(1),
    mergeReason: z.enum(["same_event", "same_announcement", "same_release", "same_research", "same_policy_change", "same_discussion", "singleton"]),
    editorialNote: z.string().max(500).optional(),
  })).min(1),
});

export type EditorialPlan = z.infer<typeof EditorialPlanSchema>;
export type EditorialPlanStory = EditorialPlan["stories"][number];
