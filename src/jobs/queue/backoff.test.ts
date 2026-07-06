import { describe, it, expect } from "vitest";
import {
  DEFAULT_BACKOFF_SCHEDULE_MS,
  DEFAULT_MAX_ATTEMPTS,
  backoffDelayMs,
  withJitter,
  nextEligibleDelayMs,
} from "./backoff.js";

describe("backoff", () => {
  it("DEFAULT_BACKOFF_SCHEDULE_MS matches §51 schedule", () => {
    expect(DEFAULT_BACKOFF_SCHEDULE_MS).toEqual([
      0,
      30_000,
      120_000,
      600_000,
      1_800_000,
    ]);
  });

  it("DEFAULT_MAX_ATTEMPTS is 5", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
  });

  it("backoffDelayMs returns schedule values (1-indexed)", () => {
    expect(backoffDelayMs(1)).toBe(0);
    expect(backoffDelayMs(2)).toBe(30_000);
    expect(backoffDelayMs(3)).toBe(120_000);
    expect(backoffDelayMs(4)).toBe(600_000);
    expect(backoffDelayMs(5)).toBe(1_800_000);
  });

  it("backoffDelayMs caps at the last schedule value beyond its length", () => {
    expect(backoffDelayMs(6)).toBe(1_800_000);
    expect(backoffDelayMs(100)).toBe(1_800_000);
  });

  it("backoffDelayMs returns 0 for nextAttempt < 1", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(-1)).toBe(0);
  });

  it("withJitter returns 0 for delayMs 0 regardless of rng", () => {
    expect(withJitter(0)).toBe(0);
    expect(withJitter(0, () => 0.5)).toBe(0);
    expect(withJitter(0, () => 1.0)).toBe(0);
  });

  it("withJitter is deterministic with a fixed rng", () => {
    expect(withJitter(30_000, () => 0.5)).toBe(30_000);
    expect(withJitter(30_000, () => 0.0)).toBe(24_000);
    expect(withJitter(30_000, () => 1.0)).toBe(36_000);
  });

  it("withJitter stays within ±20% range", () => {
    for (let i = 0; i < 200; i++) {
      const v = withJitter(30_000, Math.random);
      expect(v).toBeGreaterThanOrEqual(24_000);
      expect(v).toBeLessThanOrEqual(36_000);
    }
  });

  it("nextEligibleDelayMs with jitter=false returns the exact base delay", () => {
    expect(nextEligibleDelayMs(1, { jitter: false })).toBe(30_000);
    expect(nextEligibleDelayMs(2, { jitter: false })).toBe(120_000);
  });

  it("nextEligibleDelayMs caps at the last schedule value", () => {
    expect(nextEligibleDelayMs(5, { jitter: false })).toBe(1_800_000);
  });

  it("nextEligibleDelayMs applies jitter by default using the provided rng", () => {
    expect(nextEligibleDelayMs(1, { rng: () => 0.5 })).toBe(30_000);
    expect(nextEligibleDelayMs(1, { rng: () => 0.0 })).toBe(24_000);
    expect(nextEligibleDelayMs(1, { rng: () => 1.0 })).toBe(36_000);
  });
});
