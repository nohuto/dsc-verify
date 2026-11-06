// every value here bounds how long an object stays busy or how often it wakes

const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 5 * 60 * 1000;

export const RECONCILE_FIRST_DELAY_MS = 5_000;
export const RECONCILE_DELAYS_MS: readonly number[] = [RECONCILE_FIRST_DELAY_MS, 30_000, 120_000];

// discord deduplicates a nonce for "the past few minutes", staying under that keeps a retry safe
export const LOG_NONCE_WINDOW_MS = 2 * 60 * 1000;

export const MAX_REMOVAL_ATTEMPTS = 8;
export const MAX_DELIVERY_ATTEMPTS = 6;

// workers free allows 50 subrequests per invocation and a job makes at most 8 calls, 5 jobs fit
export const JOBS_PER_ALARM_RUN = 5;

export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const CLEANUP_BATCH_SIZE = 50;
export const FAILED_RUN_RETRY_MS = 60 * 1000;

// half fixed, half jittered
export function retryDelayMs(attempts: number, randomUnit: number): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(attempts, 16));
  return Math.ceil(ceiling / 2 + (ceiling / 2) * randomUnit);
}
