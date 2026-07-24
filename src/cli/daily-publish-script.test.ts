import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dailyPublishScript = readFileSync(
  new URL("../../scripts/daily-publish.sh", import.meta.url),
  "utf8",
);
const digestDrainScript = readFileSync(
  new URL("../../scripts/digest-drain.sh", import.meta.url),
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

  it("rolls over unready documents before evaluating readiness", () => {
    const rolloverCommand =
      'npm run digestive -- rollover-unenriched --date "$DATE"';
    const readinessCommand = 'npm run digestive -- generate-edition --date "$DATE"';
    const rolloverIndex = dailyPublishScript.indexOf(rolloverCommand);
    const readinessIndex = dailyPublishScript.indexOf(readinessCommand);

    expect(rolloverIndex).toBeGreaterThanOrEqual(0);
    expect(readinessIndex).toBeGreaterThanOrEqual(0);
    expect(rolloverIndex).toBeLessThan(readinessIndex);
  });

  it("coordinates the publication boundary with the digest drain", () => {
    expect(dailyPublishScript).toContain("/tmp/pnip-edition-boundary.lock");
    expect(dailyPublishScript).toContain("flock --exclusive 201");
    expect(digestDrainScript).toContain("flock --shared --nonblock 202");
  });

  it("warms an already-created next edition", () => {
    expect(digestDrainScript).toContain('DRAIN_NEXT_DATE="$(date -d "$DRAIN_DATE + 1 day" +%F)"');
    expect(digestDrainScript).toContain(
      'active-partitions --date "$DRAIN_NEXT_DATE"',
    );
    expect(digestDrainScript).toContain('run_process "$DRAIN_NEXT_DATE"');
  });
});
