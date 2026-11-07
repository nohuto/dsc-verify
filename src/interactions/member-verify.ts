import { ENTRY_FRAGMENT_KEY } from '../../shared/browser-contract';
import { SESSION_TTL_MS } from '../admission/admission-limits';
import { decideAdmission } from '../admission/admission-rules';
import type { AdmissionBlockReason } from '../admission/admission-rules';
import type { JourneyContext } from '../admission/member-journey';
import { digestToken } from '../crypto/canonical-encoding';
import { issueCapability } from '../crypto/capability-tokens';
import type { InteractionMember } from '../providers/discord-interactions';
import { ephemeralReply } from './interaction-replies';

const BLOCK_MESSAGES: Readonly<Record<AdmissionBlockReason, string>> = {
  bot_account: "Bots can't verify.",
  guest_member: "Guest members can't verify, join the server as a full member first.",
  pending_screening: 'Accept the server rules first, then press "Verify" again.',
  timed_out: "You can't verify while you're timed out.",
  punitive_role: 'Your account is restricted on this server, contact staff if you need help.',
  quarantined: 'AutoMod has restricted your account, update your profile or contact staff.',
  paused: 'Verification is paused right now, try again later.',
  join_changed: 'Your server membership changed, press "Verify" again.',
  generation_changed: 'This verification was reset, press "Verify" again.',
  expired: 'This verification expired, press "Verify" again.',
};

// f = full date and time, R = relative ("in 5 minutes")
function discordTimestamp(timeMs: number, style: 'f' | 'R' = 'f'): string {
  return `<t:${String(Math.floor(timeMs / 1000))}:${style}>`;
}

function verificationLinkReply(url: string): Response {
  return ephemeralReply({
    content: "This link is only for you and works for 15 minutes, please don't share it.",
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 5, label: 'Open verification', url }],
      },
    ],
  });
}

export async function startMemberVerification(
  input: { readonly operationId: string; readonly member: InteractionMember },
  context: JourneyContext,
): Promise<Response> {
  const { member, operationId } = input;
  const { config } = context;
  const nowMs = Date.now();

  // pause is authoritative inside the coordinator, which rechecks it in the same transaction
  const decision = decideAdmission({
    member,
    accessRoleId: config.memberRoleId,
    punitiveRoleIds: config.punitiveRoleIds,
    paused: false,
    nowMs,
    mode: 'automatic',
  });

  switch (decision.outcome) {
    case 'already_admitted':
      return ephemeralReply({ content: 'You already have access.' });
    case 'too_young':
      return ephemeralReply({
        content: `Your Discord account must be at least 30 days old, you can verify from ${discordTimestamp(decision.eligibleAtMs)} or ask staff for help: ${config.supportUrl}`,
      });
    case 'blocked':
      return ephemeralReply({ content: BLOCK_MESSAGES[decision.reason] });
    case 'admit':
  }

  const expirySeconds = Math.floor((nowMs + SESSION_TTL_MS) / 1000);
  const entry = await issueCapability({
    key: context.signingKey,
    context: context.config,
    purpose: 'entry',
    expirySeconds,
  });

  const started = await context.coordinator.startSession({
    operationId,
    userId: member.userId,
    joinedAtMs: member.joinedAtMs,
    entryDigest: await digestToken(entry.handle),
    expiresAtMs: expirySeconds * 1000,
  });

  switch (started.kind) {
    case 'created':
      return verificationLinkReply(`${config.origin}/#${ENTRY_FRAGMENT_KEY}=${entry.envelope}`);
    case 'duplicate':
      return ephemeralReply({ content: 'That request was already handled.' });
    case 'paused':
      return ephemeralReply({ content: BLOCK_MESSAGES.paused });
    case 'in_progress':
      return ephemeralReply({
        content: 'Your verification is almost done, check again in a moment.',
      });
    case 'rate_limited':
      return ephemeralReply({
        content: `Too many attempts, try again ${discordTimestamp(nowMs + started.retryAfterMs, 'R')}.`,
      });
  }
}
