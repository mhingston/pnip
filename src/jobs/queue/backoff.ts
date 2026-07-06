export const DEFAULT_BACKOFF_SCHEDULE_MS: readonly number[] = [
  0,
  30_000,
  120_000,
  600_000,
  1_800_000,
];

export const DEFAULT_MAX_ATTEMPTS = 5;

export function backoffDelayMs(
  nextAttempt: number,
  schedule: readonly number[] = DEFAULT_BACKOFF_SCHEDULE_MS,
): number {
  if (nextAttempt < 1) return 0;
  if (nextAttempt > schedule.length) return schedule[schedule.length - 1]!;
  return schedule[nextAttempt - 1]!;
}

export function withJitter(
  delayMs: number,
  rng: () => number = Math.random,
): number {
  if (delayMs === 0) return 0;
  return Math.round(delayMs * (0.8 + rng() * 0.4));
}

export function nextEligibleDelayMs(
  retryCountAfterFailure: number,
  opts?: {
    schedule?: readonly number[];
    jitter?: boolean;
    rng?: () => number;
  },
): number {
  const schedule = opts?.schedule ?? DEFAULT_BACKOFF_SCHEDULE_MS;
  const base = backoffDelayMs(retryCountAfterFailure + 1, schedule);
  if (opts?.jitter === false) return base;
  return withJitter(base, opts?.rng ?? Math.random);
}
