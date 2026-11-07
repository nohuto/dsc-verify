// POST isnt idempotent and the discord nonce window is short, when in doubt read the channel
// instead of posting again

import {
  AUDIT_RETENTION_MS,
  EMBED_COLOR_NEUTRAL,
  formatAuditMessage,
  isAuditKind,
  isRetentionExpired,
  parseEventMarker,
} from '../audit/audit-events';
import type { LogProfile } from '../audit/audit-events';
import { MINIMUM_ACCOUNT_AGE_MS } from '../admission/admission-rules';
import {
  deleteAuditEvent,
  enqueueLogReconcile,
  markLogPosting,
  parseMessageIds,
  readAuditEvent,
  recordLogMessages,
  removeLogMessage,
  resetLogPosting,
  setLogDeliveryState,
  setReconcileCursor,
} from '../ledger/audit-ledger';
import type { AuditRow } from '../ledger/audit-ledger';
import { readSettings, recordPanel, setSweepCursor } from '../ledger/guild-settings';
import { finishJob, hasOpenEventJob, rescheduleJob } from '../ledger/job-queue';
import type { JobRow } from '../ledger/job-queue';
import {
  createMessage,
  deleteMessage,
  editMessage,
  getUser,
  listChannelMessages,
} from '../providers/discord-rest';
import type { ChannelMessage, RestOutcome } from '../providers/discord-rest';
import { VERIFY_BUTTON_CUSTOM_ID } from '../../shared/slash-commands';
import { deferForRateLimit, deferWithBackoff } from './job-context';
import type { JobContext, JobRunResult } from './job-context';
import { LOG_NONCE_WINDOW_MS, MAX_DELIVERY_ATTEMPTS } from './retry-schedule';

const RECONCILE_PAGE_LIMIT = 100;
const RECONCILE_PAGES_PER_RUN = 3;
const RECONCILE_SCAN_WINDOW_MS = 15 * 60 * 1000;
const RECONCILE_LOOKBACK_MS = 60 * 1000;
const DELETES_PER_RUN = 5;
const CONTINUATION_DELAY_MS = 1000;
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const SNOWFLAKE_TIMESTAMP_SHIFT = 22n;

function snowflakeFromTime(timeMs: number): string {
  const offset = BigInt(Math.floor(timeMs)) - DISCORD_EPOCH_MS;
  return offset <= 0n ? '0' : (offset << SNOWFLAKE_TIMESTAMP_SHIFT).toString();
}

function timeFromSnowflake(id: string): number {
  return Number((BigInt(id) >> SNOWFLAKE_TIMESTAMP_SHIFT) + DISCORD_EPOCH_MS);
}

function sortOldestFirst(messages: readonly ChannelMessage[]): ChannelMessage[] {
  return [...messages].sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
}

function audienceMessage(event: AuditRow, profile: LogProfile | undefined) {
  if (!isAuditKind(event.kind)) throw new Error('unknown audit kind');
  return formatAuditMessage(
    {
      id: event.id,
      kind: event.kind,
      subjectId: event.subject_id,
      actorId: event.actor_id,
      outcome: event.outcome,
      reason: event.reason,
      createdAtMs: event.created_at,
    },
    profile,
  );
}

function needsReconcile(event: AuditRow, nowMs: number): boolean {
  const nonceExpired = nowMs - (event.posted_at ?? nowMs) > LOG_NONCE_WINDOW_MS;
  return event.delivery_state === 'erasing' || nonceExpired;
}

export async function runLogPostJob(context: JobContext, job: JobRow): Promise<JobRunResult> {
  const { store, config, rest } = context;
  let event = job.event_id === null ? null : readAuditEvent(store, job.event_id);
  const profileId = event?.subject_id ?? event?.actor_id ?? null;
  let profile: LogProfile | undefined;
  if (event !== null && profileId !== null && !needsReconcile(event, context.nowMs())) {
    const user = await getUser(rest, profileId);
    if (user.kind === 'rate_limited') return deferForRateLimit(context, job, user);
    if (user.kind === 'ok') profile = { userId: profileId, ...user.value };
    // erasure can land during the lookup, so every check below reads the event after it
    event = readAuditEvent(store, event.id);
  }
  const nowMs = context.nowMs();
  if (event === null) {
    finishJob(store, job, { state: 'cancelled', result: 'event_gone', nowMs });
    return 'continue';
  }
  // still posting means an earlier attempt died mid request, a refused retry must not reopen its
  // window
  if (event.delivery_state === 'posting') setLogDeliveryState(store, event.id, 'ambiguous');

  if (needsReconcile(event, nowMs)) {
    enqueueLogReconcile(store, event.id, nowMs);
    finishJob(store, job, { state: 'done', result: 'reconciling', nowMs });
    return 'continue';
  }

  markLogPosting(store, event.id, nowMs);
  const result = await createMessage(rest, {
    channelId: config.logChannelId,
    nonce: event.id,
    payload: audienceMessage(event, profile),
  });
  const settledAt = context.nowMs();

  switch (result.kind) {
    case 'ok':
      recordLogMessages(store, event.id, [result.value.messageId], settledAt);
      finishJob(store, job, { state: 'done', result: 'delivered', nowMs: settledAt });
      return 'continue';
    case 'rate_limited':
      resetLogPosting(store, event.id);
      return deferForRateLimit(context, job, result);
    case 'uncertain':
    case 'malformed':
      setLogDeliveryState(store, event.id, 'ambiguous');
      return deferWithBackoff(context, job);
    case 'unavailable':
      resetLogPosting(store, event.id);
      return deferWithBackoff(context, job);
    case 'forbidden':
    case 'not_found':
    case 'rejected':
      setLogDeliveryState(store, event.id, 'unresolved');
      finishJob(store, job, { state: 'unresolved', result: 'delivery_refused', nowMs: settledAt });
      return 'continue';
  }
}

export async function runLogReconcileJob(context: JobContext, job: JobRow): Promise<JobRunResult> {
  const { store, config, rest } = context;
  const event = job.event_id === null ? null : readAuditEvent(store, job.event_id);
  if (event === null) {
    finishJob(store, job, { state: 'cancelled', result: 'event_gone', nowMs: context.nowMs() });
    return 'continue';
  }

  const postedAt = event.posted_at ?? event.created_at;
  let cursor = event.reconcile_cursor ?? snowflakeFromTime(postedAt - RECONCILE_LOOKBACK_MS);
  const found: string[] = [];
  let reachedEnd = false;
  // copies found on earlier pages are kept on every exit, the cursor already moved past them
  const saveProgress = (): void => {
    if (found.length > 0) recordLogMessages(store, event.id, found, context.nowMs());
    setReconcileCursor(store, event.id, cursor);
  };

  for (let page = 0; page < RECONCILE_PAGES_PER_RUN && !reachedEnd; page += 1) {
    const listed: RestOutcome<readonly ChannelMessage[]> = await listChannelMessages(rest, {
      channelId: config.logChannelId,
      after: cursor,
      limit: RECONCILE_PAGE_LIMIT,
    });
    if (listed.kind === 'rate_limited') {
      saveProgress();
      return deferForRateLimit(context, job, listed);
    }
    if (listed.kind !== 'ok') {
      saveProgress();
      return deferDelivery(context, job, event.id);
    }

    for (const message of sortOldestFirst(listed.value)) {
      cursor = message.id;
      const isOwnCopy =
        message.authorId === config.applicationId && parseEventMarker(message.marker) === event.id;
      if (isOwnCopy) found.push(message.id);
    }
    const scannedPastWindow = timeFromSnowflake(cursor) > postedAt + RECONCILE_SCAN_WINDOW_MS;
    reachedEnd = listed.value.length < RECONCILE_PAGE_LIMIT || scannedPastWindow;
  }

  saveProgress();
  if (!reachedEnd) return continueLogJob(context, job);

  const nowMs = context.nowMs();
  const latest = readAuditEvent(store, event.id);
  const hasCopies = latest !== null && parseMessageIds(latest.message_ids).length > 0;
  // erasure search that finds nothing is the good outcome
  const settled = hasCopies || latest?.delivery_state === 'erasing';
  if (!hasCopies) setLogDeliveryState(store, event.id, 'unresolved');
  finishJob(store, job, {
    state: settled ? 'done' : 'unresolved',
    result: hasCopies ? 'reconciled' : 'not_found',
    nowMs,
  });
  return 'continue';
}

function deferDelivery(context: JobContext, job: JobRow, eventId: string): JobRunResult {
  if (job.attempts + 1 < MAX_DELIVERY_ATTEMPTS) return deferWithBackoff(context, job);
  setLogDeliveryState(context.store, eventId, 'unresolved');
  finishJob(context.store, job, {
    state: 'unresolved',
    result: 'retries_exhausted',
    nowMs: context.nowMs(),
  });
  return 'continue';
}

export async function runLogDeleteJob(context: JobContext, job: JobRow): Promise<JobRunResult> {
  const { store, config, rest } = context;
  const event = job.event_id === null ? null : readAuditEvent(store, job.event_id);
  if (event === null) {
    finishJob(store, job, { state: 'cancelled', result: 'event_gone', nowMs: context.nowMs() });
    return 'continue';
  }

  for (const messageId of parseMessageIds(event.message_ids).slice(0, DELETES_PER_RUN)) {
    const deleted = await deleteMessage(rest, { channelId: config.logChannelId, messageId });
    switch (deleted.kind) {
      case 'ok':
      case 'not_found':
        removeLogMessage(store, event.id, messageId);
        break;
      case 'rate_limited':
        return deferForRateLimit(context, job, deleted);
      case 'forbidden':
        setLogDeliveryState(store, event.id, 'unresolved');
        finishJob(store, job, {
          state: 'unresolved',
          result: 'delete_refused',
          nowMs: context.nowMs(),
        });
        return 'continue';
      case 'rejected':
      case 'unavailable':
      case 'uncertain':
      case 'malformed':
        return deferDelivery(context, job, event.id);
    }
  }

  const nowMs = context.nowMs();
  const latest = readAuditEvent(store, event.id);
  if (latest !== null && parseMessageIds(latest.message_ids).length > 0) {
    return continueLogJob(context, job);
  }

  // search still paging for this event needs the row to record and delete what it finds
  const canDrop =
    latest !== null &&
    (latest.delivery_state === 'erasing' || isRetentionExpired(latest.expires_at, nowMs)) &&
    !hasOpenEventJob(store, event.id, job.id);
  if (canDrop) deleteAuditEvent(store, event.id);
  finishJob(store, job, { state: 'done', result: 'deleted', nowMs });
  return 'continue';
}

// walks history older than the retention target once, every tagged bot copy there is expired, this
// also catches duplicates no audit row knows about
export async function runLogSweepJob(context: JobContext, job: JobRow): Promise<JobRunResult> {
  const { store, config, rest } = context;
  const boundary = BigInt(snowflakeFromTime(context.nowMs() - AUDIT_RETENTION_MS));
  let cursor = readSettings(store).sweep_cursor ?? '0';
  let deletes = 0;
  const finishSweep = (state: 'done' | 'cancelled', result: string): JobRunResult => {
    setSweepCursor(store, cursor);
    finishJob(store, job, { state, result, nowMs: context.nowMs() });
    return 'continue';
  };

  for (let page = 0; page < RECONCILE_PAGES_PER_RUN; page += 1) {
    const listed = await listChannelMessages(rest, {
      channelId: config.logChannelId,
      after: cursor,
      limit: RECONCILE_PAGE_LIMIT,
    });
    if (listed.kind === 'rate_limited') {
      setSweepCursor(store, cursor);
      return deferForRateLimit(context, job, listed);
    }
    if (listed.kind !== 'ok') return finishSweep('cancelled', 'sweep_deferred');

    for (const message of sortOldestFirst(listed.value)) {
      if (BigInt(message.id) >= boundary) return finishSweep('done', 'swept');
      const eventId = parseEventMarker(message.marker);
      if (message.authorId === config.applicationId && eventId !== null) {
        if (deletes >= DELETES_PER_RUN) {
          setSweepCursor(store, cursor);
          return continueLogJob(context, job);
        }
        deletes += 1;
        const deleted = await deleteMessage(rest, {
          channelId: config.logChannelId,
          messageId: message.id,
        });
        if (deleted.kind === 'rate_limited') {
          setSweepCursor(store, cursor);
          return deferForRateLimit(context, job, deleted);
        }
        if (deleted.kind === 'ok' || deleted.kind === 'not_found') {
          removeLogMessage(store, eventId, message.id);
        } else if (deleted.kind !== 'forbidden' && deleted.kind !== 'rejected') {
          return finishSweep('cancelled', 'sweep_deferred');
        }
      }
      cursor = message.id;
    }

    if (listed.value.length < RECONCILE_PAGE_LIMIT) return finishSweep('done', 'swept');
  }

  setSweepCursor(store, cursor);
  return continueLogJob(context, job);
}

function continueLogJob(context: JobContext, job: JobRow): JobRunResult {
  const nowMs = context.nowMs();
  rescheduleJob(context.store, job, {
    nextRunAt: nowMs + CONTINUATION_DELAY_MS,
    countAttempt: false,
    nowMs,
  });
  return 'continue';
}

const MINIMUM_ACCOUNT_AGE_DAYS = MINIMUM_ACCOUNT_AGE_MS / (24 * 60 * 60 * 1000);

// content is empty on purpose
function panelMessage(origin: string) {
  return {
    content: '',
    embeds: [
      {
        title: 'Verification',
        description: `Verify to get access to the server. You sign in with Discord and pass a quick browser check, it takes about a minute.\n\nYour account must be at least ${String(MINIMUM_ACCOUNT_AGE_DAYS)} days old.`,
        color: EMBED_COLOR_NEUTRAL,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: 'Verify', custom_id: VERIFY_BUTTON_CUSTOM_ID },
          { type: 2, style: 5, label: 'Privacy', url: `${origin}/privacy` },
        ],
      },
    ],
  };
}

export async function runPanelJob(context: JobContext, job: JobRow): Promise<JobRunResult> {
  const { store, rest } = context;
  const channelId = job.payload;
  if (channelId === null) {
    finishJob(store, job, { state: 'cancelled', result: 'invalid', nowMs: context.nowMs() });
    return 'continue';
  }

  const settings = readSettings(store);
  if (settings.panel_channel_id === channelId && settings.panel_message_id !== null) {
    const edited = await editMessage(rest, {
      channelId,
      messageId: settings.panel_message_id,
      payload: panelMessage(context.config.origin),
    });
    if (edited.kind === 'ok') {
      finishJob(store, job, { state: 'done', result: 'updated', nowMs: context.nowMs() });
      return 'continue';
    }
    if (edited.kind === 'rate_limited') return deferForRateLimit(context, job, edited);
    if (edited.kind !== 'not_found') return deferPanel(context, job);
  }

  const created = await createMessage(rest, {
    channelId,
    nonce: job.id.replaceAll('-', '').slice(0, 25),
    payload: panelMessage(context.config.origin),
  });
  if (created.kind === 'ok') {
    recordPanel(store, channelId, created.value.messageId);
    finishJob(store, job, { state: 'done', result: 'posted', nowMs: context.nowMs() });
    return 'continue';
  }
  if (created.kind === 'rate_limited') return deferForRateLimit(context, job, created);
  return deferPanel(context, job);
}

function deferPanel(context: JobContext, job: JobRow): JobRunResult {
  if (job.attempts + 1 < MAX_DELIVERY_ATTEMPTS) return deferWithBackoff(context, job);
  finishJob(context.store, job, {
    state: 'unresolved',
    result: 'panel_failed',
    nowMs: context.nowMs(),
  });
  return 'continue';
}
