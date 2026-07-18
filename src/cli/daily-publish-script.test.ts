import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dailyPublishScript = readFileSync(
  new URL("../../scripts/daily-publish.sh", import.meta.url),
  "utf8",
);

describe("daily-publish orchestration", () => {
  it("transitions the edition to ready before generating the digest", () => {
    const readinessCommand = 'npm run digestive -- generate-edition --date "$DATE"';
    const digestCommand = 'npm run digestive -- generate-digest --date "$DATE"';
    const readinessIndex = dailyPublishScript.indexOf(readinessCommand);
    const digestIndex = dailyPublishScript.indexOf(digestCommand);

    expect(readinessIndex).toBeGreaterThanOrEqual(0);
    expect(digestIndex).toBeGreaterThanOrEqual(0);
    expect(readinessIndex).toBeLessThan(digestIndex);
  });
});
