export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const EVENT_MARKER_PREFIX = 'verification-event:';

const EVENT_ID_LENGTH = 24;

const EMBED_COLOR_NEUTRAL = 0x5865f2;

const EMBED_COLOR_ALERT = 0xed4245;

const KIND_TITLES = {
  admission_queued: 'Admission queued',
  admission_confirmed: 'Admission confirmed',
  admission_blocked: 'Admission blocked',
  admission_expired: 'Admission expired',
  staff_approved: 'Staff approval',
  staff_reset: 'Staff reset',
  reset_observed: 'Reset observed',
  reset_unresolved: 'Reset unresolved',
  role_unresolved: 'Role state unresolved',
  possible_late_effect: 'Possible late role effect',
  verification_paused: 'Verification paused',
  verification_resumed: 'Verification resumed',
  operator_fault: 'Operator fault',
  data_erased: 'Data erasure completed',
} as const;

export type AuditKind = keyof typeof KIND_TITLES;

const ALERT_KINDS: ReadonlySet<AuditKind> = new Set<AuditKind>([
  'reset_unresolved',
  'role_unresolved',
  'possible_late_effect',
  'operator_fault',
]);

type AuditMessageInput = {
  readonly id: string;
  readonly kind: AuditKind;
  readonly subjectId: string | null;
  readonly actorId: string | null;
  readonly outcome: string;
  readonly reason: string | null;
  readonly createdAtMs: number;
};

export function createEventId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, EVENT_ID_LENGTH);
}

export function eventMarker(eventId: string): string {
  return `${EVENT_MARKER_PREFIX}${eventId}`;
}

export function parseEventMarker(marker: string | null): string | null {
  if (marker === null || !marker.startsWith(EVENT_MARKER_PREFIX)) return null;
  const eventId = marker.slice(EVENT_MARKER_PREFIX.length);
  return /^[0-9a-f]{24}$/.test(eventId) ? eventId : null;
}

export function formatAuditMessage(event: AuditMessageInput): { readonly embeds: unknown[] } {
  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: 'Outcome', value: event.outcome, inline: true },
  ];
  if (event.subjectId !== null) {
    fields.push({ name: 'Member', value: `<@${event.subjectId}>`, inline: true });
  }
  if (event.actorId !== null) {
    fields.push({ name: 'Staff', value: `<@${event.actorId}>`, inline: true });
  }
  if (event.reason !== null) {
    fields.push({ name: 'Reason', value: event.reason, inline: false });
  }

  return {
    embeds: [
      {
        title: KIND_TITLES[event.kind],
        color: ALERT_KINDS.has(event.kind) ? EMBED_COLOR_ALERT : EMBED_COLOR_NEUTRAL,
        fields,
        timestamp: new Date(event.createdAtMs).toISOString(),
        footer: { text: eventMarker(event.id) },
      },
    ],
  };
}

export function isAuditKind(value: string): value is AuditKind {
  return Object.hasOwn(KIND_TITLES, value);
}

export function auditExpiresAtMs(createdAtMs: number): number {
  return createdAtMs + AUDIT_RETENTION_MS;
}

export function isRetentionExpired(expiresAtMs: number, nowMs: number): boolean {
  return nowMs >= expiresAtMs;
}
