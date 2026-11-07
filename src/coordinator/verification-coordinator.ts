import { DurableObject } from 'cloudflare:workers';

import { readConfig } from '../deployment-config';
import { eraseMemberData, runCleanup } from '../ledger/data-retention';
import { requestLogSweep } from '../ledger/audit-ledger';
import {
  ensureCleanupScheduled,
  readSettings,
  requestPanel,
  setDiscordBlockedUntil,
  setNextCleanupAt,
  setPaused,
} from '../ledger/guild-settings';
import { claimDueJob, nextDueAt } from '../ledger/job-queue';
import type { JobRow } from '../ledger/job-queue';
import { requestStaffGrant, resetMember } from '../ledger/role-intents';
import { ensureSchema } from '../ledger/schema';
import {
  beginAuthorization,
  beginSession,
  claimSubmission,
  consumeAuthorization,
  exchangeEntry,
  finalizeChallenge,
  finishAuthorization,
  readAttemptStatus,
  recordAuthorizationDenied,
} from '../ledger/session-ledger';
import type { Store } from '../ledger/sqlite';
import { readConfigurationStatus, readMemberStatus } from '../ledger/status-views';
import { getChannel, getCurrentUserId, getGuild, getGuildMember } from '../providers/discord-rest';
import type { ChannelSummary } from '../providers/discord-rest';
import { evaluatePreflight } from './guild-preflight';
import type { PreflightSnapshot } from './guild-preflight';
import { deferWithBackoff } from './job-context';
import type { JobContext, JobRunResult } from './job-context';
import {
  runLogDeleteJob,
  runLogPostJob,
  runLogReconcileJob,
  runLogSweepJob,
  runPanelJob,
} from './log-jobs';
import {
  CLEANUP_BATCH_SIZE,
  CLEANUP_INTERVAL_MS,
  FAILED_RUN_RETRY_MS,
  JOBS_PER_ALARM_RUN,
} from './retry-schedule';
import { runGrantJob, runReconcileJob, runRemoveJob } from './role-jobs';

export type ResumeResult =
  | { readonly kind: 'resumed' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'preflight_failed'; readonly codes: readonly string[] }
  | { readonly kind: 'preflight_unavailable' };

const JOB_RUNNERS = {
  grant: runGrantJob,
  remove: runRemoveJob,
  reconcile: runReconcileJob,
  log_post: runLogPostJob,
  log_reconcile: runLogReconcileJob,
  log_delete: runLogDeleteJob,
  log_sweep: runLogSweepJob,
  panel: runPanelJob,
} satisfies Record<JobRow['kind'], (context: JobContext, job: JobRow) => Promise<JobRunResult>>;

function logSafeEvent(event: string, detail: string): void {
  console.error(JSON.stringify({ event, detail }));
}

// each RPC takes the input of its ledger function, the object supplies the time
type RpcInput<F extends (store: Store, input: never) => unknown> = Omit<Parameters<F>[1], 'nowMs'>;

export class VerificationCoordinator extends DurableObject<Env> {
  private readonly store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = ctx.storage;
    ensureSchema(this.store);
  }

  startSession(input: RpcInput<typeof beginSession>) {
    const nowMs = Date.now();
    const result = beginSession(this.store, { ...input, nowMs });
    if (result.kind === 'created') this.armWork(nowMs);
    return result;
  }

  // the status comes back in the same call, the page needs it right after the exchange
  exchangeEntry(input: RpcInput<typeof exchangeEntry>) {
    const nowMs = Date.now();
    const result = exchangeEntry(this.store, { ...input, nowMs });
    if (result.kind !== 'created' && result.kind !== 'reused') return { ...result, status: null };
    const digest =
      result.kind === 'reused' && input.existingBrowserDigest !== null
        ? input.existingBrowserDigest
        : input.browserDigest;
    return { ...result, status: readAttemptStatus(this.store, digest, nowMs) };
  }

  readStatus(browserDigest: string) {
    return readAttemptStatus(this.store, browserDigest, Date.now());
  }

  beginAuthorization(input: RpcInput<typeof beginAuthorization>) {
    return beginAuthorization(this.store, { ...input, nowMs: Date.now() });
  }

  consumeAuthorization(input: RpcInput<typeof consumeAuthorization>) {
    return consumeAuthorization(this.store, { ...input, nowMs: Date.now() });
  }

  finishAuthorization(input: RpcInput<typeof finishAuthorization>) {
    return finishAuthorization(this.store, { ...input, nowMs: Date.now() });
  }

  recordAuthorizationDenied(input: RpcInput<typeof recordAuthorizationDenied>) {
    return recordAuthorizationDenied(this.store, { ...input, nowMs: Date.now() });
  }

  claimSubmission(input: RpcInput<typeof claimSubmission>) {
    return claimSubmission(this.store, { ...input, nowMs: Date.now() });
  }

  finalizeChallenge(input: RpcInput<typeof finalizeChallenge>) {
    const nowMs = Date.now();
    const result = finalizeChallenge(this.store, { ...input, nowMs });
    if (result.kind !== 'queued') return result;
    this.armWork(nowMs);
    return { ...result, status: readAttemptStatus(this.store, input.browserDigest, nowMs) };
  }

  approveMember(input: RpcInput<typeof requestStaffGrant>) {
    const nowMs = Date.now();
    const result = requestStaffGrant(this.store, { ...input, nowMs });
    this.armWork(nowMs);
    return result;
  }

  resetMember(input: RpcInput<typeof resetMember>) {
    const nowMs = Date.now();
    const result = resetMember(this.store, { ...input, nowMs });
    this.armWork(nowMs);
    return result;
  }

  eraseMember(input: RpcInput<typeof eraseMemberData>) {
    const nowMs = Date.now();
    const result = eraseMemberData(this.store, { ...input, nowMs });
    this.armWork(nowMs);
    return result;
  }

  requestPanel(input: RpcInput<typeof requestPanel>) {
    const nowMs = Date.now();
    const result = requestPanel(this.store, { ...input, nowMs });
    this.armWork(nowMs);
    return result;
  }

  pauseVerification(input: {
    readonly operationId: string;
    readonly actorId: string;
    readonly reason: string;
  }) {
    const nowMs = Date.now();
    const result = setPaused(this.store, { ...input, paused: true, nowMs });
    this.armWork(nowMs);
    return result;
  }

  // refused, a broken configuration would only pause again on the next grant
  async resumeVerification(input: {
    readonly operationId: string;
    readonly actorId: string;
  }): Promise<ResumeResult> {
    const context = this.jobContext();
    if (context === null) return { kind: 'preflight_unavailable' };

    const revision = readSettings(this.store).pause_revision;
    const snapshot = await this.collectPreflightSnapshot(context);
    if (snapshot === null) return { kind: 'preflight_unavailable' };

    const codes = evaluatePreflight(context.config, snapshot)
      .filter((finding) => finding.severity === 'error')
      .map((finding) => finding.code);
    if (codes.length > 0) return { kind: 'preflight_failed', codes };

    // pause accepted during preflight is newer than this resume
    if (readSettings(this.store).pause_revision !== revision) return { kind: 'superseded' };
    const nowMs = Date.now();
    const result = setPaused(this.store, {
      operationId: input.operationId,
      actorId: input.actorId,
      paused: false,
      reason: null,
      nowMs,
    });
    this.armWork(nowMs);
    return result.kind === 'duplicate' ? { kind: 'duplicate' } : { kind: 'resumed' };
  }

  readMemberStatus(userId: string) {
    return readMemberStatus(this.store, userId);
  }

  readConfigurationStatus() {
    return readConfigurationStatus(this.store);
  }

  private async collectPreflightSnapshot({
    config,
    rest,
  }: JobContext): Promise<PreflightSnapshot | null> {
    const botUser = await getCurrentUserId(rest);
    if (botUser.kind !== 'ok') return null;
    // parallel, the deferred reply has to arrive within the waitUntil limit
    const [guild, botMember, verificationChannel, logChannel] = await Promise.all([
      getGuild(rest, config.guildId),
      getGuildMember(rest, config.guildId, botUser.value),
      getChannel(rest, config.verificationChannelId),
      getChannel(rest, config.logChannelId),
    ]);
    if (guild.kind !== 'ok' || botMember.kind !== 'ok') return null;
    // 404 or 403 = missing or hidden channel, any other failure leaves the check unanswered
    const channels = [verificationChannel, logChannel].map(
      (outcome): ChannelSummary | null | undefined => {
        if (outcome.kind === 'ok') return outcome.value;
        const refused =
          outcome.kind === 'not_found' || (outcome.kind === 'forbidden' && outcome.status === 403);
        return refused ? null : undefined;
      },
    );
    const [verification, log] = channels;
    if (verification === undefined || log === undefined) return null;

    return {
      botUserId: botUser.value,
      botRoleIds: botMember.value.roleIds,
      guildOwnerId: guild.value.ownerId,
      guildRequiresMfa: guild.value.requiresMfa,
      roles: guild.value.roles,
      verificationChannel: verification,
      logChannel: log,
    };
  }

  private jobContext(): JobContext | null {
    const result = readConfig(this.env as unknown as Readonly<Record<string, unknown>>);
    if (!result.ok) {
      logSafeEvent('configuration_invalid', result.invalid.join(','));
      return null;
    }
    return {
      store: this.store,
      config: result.config,
      rest: { botToken: result.config.discordBotToken },
      nowMs: () => Date.now(),
      random: () => Math.random(),
    };
  }

  // every write path that leaves data behind also arms retention cleanup
  private armWork(nowMs: number): void {
    ensureCleanupScheduled(this.store, nowMs + CLEANUP_INTERVAL_MS);
    this.scheduleWake();
  }

  // alarm = earliest due time in SQL
  private scheduleWake(): void {
    const wakeAt = this.nextWakeAt();
    if (wakeAt === null) return;
    this.ctx.storage.setAlarm(Math.max(wakeAt, Date.now())).catch(() => {
      logSafeEvent('alarm_failed', 'set');
    });
  }

  private nextWakeAt(): number | null {
    const settings = readSettings(this.store);
    const jobsDueAt = nextDueAt(this.store);
    const blockedJobsDueAt =
      jobsDueAt === null ? null : Math.max(jobsDueAt, settings.discord_blocked_until);
    const candidates = [blockedJobsDueAt, settings.next_cleanup_at].filter(
      (time): time is number => time !== null,
    );
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  // platform alarm retries are finite, this handler never throws and reschedules unfinished work
  // itself, nothing here keeps the object awake between runs
  override async alarm(): Promise<void> {
    try {
      const context = this.jobContext();
      if (context === null) {
        await this.ctx.storage.setAlarm(Date.now() + FAILED_RUN_RETRY_MS);
        return;
      }
      await this.runDueJobs(context);
      this.runHousekeepingIfDue();
    } catch {
      logSafeEvent('alarm_failed', 'unexpected');
      await this.ctx.storage.setAlarm(Date.now() + FAILED_RUN_RETRY_MS);
      return;
    }
    this.scheduleWake();
  }

  private async runDueJobs(context: JobContext): Promise<void> {
    const blockedUntil = readSettings(this.store).discord_blocked_until;
    if (blockedUntil > Date.now()) return;
    if (blockedUntil !== 0) setDiscordBlockedUntil(this.store, 0);

    for (let count = 0; count < JOBS_PER_ALARM_RUN; count += 1) {
      const job = claimDueJob(this.store, Date.now());
      if (job === null) return;
      if ((await this.runJob(context, job)) === 'stop_batch') return;
    }
  }

  private async runJob(context: JobContext, job: JobRow): Promise<JobRunResult> {
    try {
      return await JOB_RUNNERS[job.kind](context, job);
    } catch {
      logSafeEvent('job_failed', job.kind);
      return deferWithBackoff(context, job);
    }
  }

  private runHousekeepingIfDue(): void {
    const nowMs = Date.now();
    const { next_cleanup_at: cleanupAt } = readSettings(this.store);
    if (cleanupAt === null || cleanupAt > nowMs) return;

    const retainedData = runCleanup(this.store, nowMs, CLEANUP_BATCH_SIZE);
    if (retainedData) requestLogSweep(this.store, nowMs);
    setNextCleanupAt(this.store, retainedData ? nowMs + CLEANUP_INTERVAL_MS : null);
  }
}
