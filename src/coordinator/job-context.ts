import type { AppConfig } from '../deployment-config';
import { setDiscordBlockedUntil } from '../ledger/guild-settings';
import { rescheduleJob } from '../ledger/job-queue';
import type { JobRow } from '../ledger/job-queue';
import type { Store } from '../ledger/sqlite';
import type { RestContext, RestFailure } from '../providers/discord-rest';
import { retryDelayMs } from './retry-schedule';

export type JobContext = {
  readonly store: Store;
  readonly config: AppConfig;
  readonly rest: RestContext;
  readonly nowMs: () => number;
  readonly random: () => number;
};

export type JobRunResult = 'continue' | 'stop_batch';

export type RateLimited = Extract<RestFailure, { kind: 'rate_limited' }>;

// 429 = request wasnt processed, doesnt count as an attempt, global and edge limits hit every
// route, the run stops instead of collecting more 429s
export function deferForRateLimit(
  context: JobContext,
  job: JobRow,
  failure: RateLimited,
): JobRunResult {
  const nowMs = context.nowMs();
  rescheduleJob(context.store, job, {
    nextRunAt: nowMs + failure.retryAfterMs,
    countAttempt: false,
    nowMs,
  });
  return blockForRateLimit(context, failure, nowMs);
}

export function blockForRateLimit(
  context: JobContext,
  failure: RateLimited,
  nowMs = context.nowMs(),
): JobRunResult {
  if (failure.scope !== 'global' && failure.scope !== 'edge') return 'continue';
  setDiscordBlockedUntil(context.store, nowMs + failure.retryAfterMs);
  return 'stop_batch';
}

export function deferWithBackoff(context: JobContext, job: JobRow): JobRunResult {
  const nowMs = context.nowMs();
  rescheduleJob(context.store, job, {
    nextRunAt: nowMs + retryDelayMs(job.attempts, context.random()),
    countAttempt: true,
    nowMs,
  });
  return 'continue';
}
