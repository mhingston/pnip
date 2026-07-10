export interface ContinuityStoryIdentity {
  label: string;
  urls: string[];
}

export type StoryContinuity =
  | { kind: "new" }
  | {
      kind: "continuing";
      previousStoryLabel: string;
      reason: "shared_source" | "same_specific_label";
    };

function normalizedLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isSpecificLabel(label: string): boolean {
  return normalizedLabel(label).split(" ").filter(Boolean).length >= 5;
}

export function classifyStoryContinuity(
  current: ContinuityStoryIdentity,
  previousStories: ContinuityStoryIdentity[],
): StoryContinuity {
  const currentUrls = new Set(current.urls.filter(Boolean));
  for (const previous of previousStories) {
    if (previous.urls.some((url) => currentUrls.has(url))) {
      return {
        kind: "continuing",
        previousStoryLabel: previous.label,
        reason: "shared_source",
      };
    }
  }

  const label = normalizedLabel(current.label);
  if (isSpecificLabel(label)) {
    for (const previous of previousStories) {
      if (normalizedLabel(previous.label) === label) {
        return {
          kind: "continuing",
          previousStoryLabel: previous.label,
          reason: "same_specific_label",
        };
      }
    }
  }
  return { kind: "new" };
}
