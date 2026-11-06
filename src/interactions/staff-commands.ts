// command visibility is only a convenience, channel permissions from the signed payload give an
// instant refusal, then the reply is deferred and every subcommand is authorized again on guild
// roles, and delayed work rechecks authority once more

import { MAX_REASON_LENGTH } from '../admission/admission-limits';
import { decideAdmission } from '../admission/admission-rules';
import type { JourneyContext } from '../admission/member-journey';
import type { ResumeResult } from '../coordinator/verification-coordinator';
import type { ConfigurationStatus, MemberStatus } from '../ledger/status-views';
import type {
  CommandInteraction,
  InteractionMember,
  ResolvedTarget,
} from '../providers/discord-interactions';
import { editOriginalInteractionResponse } from '../providers/discord-rest';
import { guildStaffActor, readGuildAuthority } from '../staff/guild-authority';
import { authorizeStaffAction } from '../staff/staff-authority';
import type { StaffAction, StaffActor } from '../staff/staff-authority';
import { deferredEphemeralReply, ephemeralReply, EPHEMERAL_FLAG } from './interaction-replies';

const NOT_ALLOWED = 'You are not allowed to do that.';
const ALREADY_HANDLED = 'That request was already handled.';
const CHECK_UNAVAILABLE = 'Discord did not answer the permission check. Try again shortly.';
const MEMBER_AND_REASON = 'A member and a reason of 1 to 500 characters are required.';

type StaffRequest = {
  readonly interaction: CommandInteraction;
  readonly actor: InteractionMember;
  readonly action: StaffAction;
  readonly target: ResolvedTarget | null;
};

function readReason(interaction: CommandInteraction): string | null {
  const reason = interaction.options.get('reason')?.trim();
  if (reason === undefined || reason === '' || reason.length > MAX_REASON_LENGTH) return null;
  return reason;
}

function readTarget(interaction: CommandInteraction): ResolvedTarget | null {
  const targetId = interaction.options.get('member');
  return targetId === undefined ? null : (interaction.targets.get(targetId) ?? null);
}

function actionFor(subcommand: string | null, hasTarget: boolean): StaffAction | null {
  switch (subcommand) {
    case 'panel':
    case 'approve':
    case 'reset':
    case 'pause':
    case 'resume':
      return subcommand;
    case 'status':
      return hasTarget ? 'status_member' : 'status_configuration';
    case 'delete-data':
      return 'delete_data';
    case null:
    default:
      return null;
  }
}

function isAllowed(
  request: StaffRequest,
  staffRoleIds: readonly string[],
  asStaff: (userId: string, member: InteractionMember) => StaffActor,
): boolean {
  const targetMember = request.target?.member ?? null;
  return authorizeStaffAction({
    action: request.action,
    staffRoleIds,
    actor: asStaff(request.actor.userId, request.actor),
    ...(request.target === null || targetMember === null
      ? {}
      : { target: asStaff(request.target.userId, targetMember) }),
  }).allowed;
}

export function handleStaffCommand(
  interaction: CommandInteraction,
  actor: InteractionMember,
  context: JourneyContext,
): Response {
  const target = readTarget(interaction);
  const action = actionFor(interaction.subcommand, target !== null);
  if (action === null) return ephemeralReply({ content: 'Unknown command.' });
  const request = { interaction, actor, action, target };

  const channelActor = (_: string, member: InteractionMember): StaffActor => ({
    isOwner: false,
    permissions: member.permissions,
    roleIds: member.roleIds,
  });
  if (!isAllowed(request, context.config.staffRoleIds, channelActor)) {
    return ephemeralReply({ content: NOT_ALLOWED });
  }

  context.execution.waitUntil(
    finishStaffCommand(request, context).catch(() => {
      console.error(JSON.stringify({ event: 'staff_command_failed', detail: action }));
    }),
  );
  return deferredEphemeralReply();
}

async function finishStaffCommand(request: StaffRequest, context: JourneyContext): Promise<void> {
  const content = await authorizeAndRun(request, context);
  await editOriginalInteractionResponse({
    applicationId: context.config.applicationId,
    interactionToken: request.interaction.token,
    payload: { content, flags: EPHEMERAL_FLAG },
  });
}

// interaction permissions are per channel and shrink during a timeout, guild roles decide for actor
// and target
async function authorizeAndRun(request: StaffRequest, context: JourneyContext): Promise<string> {
  const { config } = context;
  const guild = await readGuildAuthority({ botToken: config.discordBotToken }, config.guildId);
  if (guild.kind !== 'ok') return CHECK_UNAVAILABLE;
  const guildActor = (userId: string, member: InteractionMember): StaffActor =>
    guildStaffActor(guild.value, userId, member.roleIds);
  if (!isAllowed(request, config.staffRoleIds, guildActor)) return NOT_ALLOWED;

  switch (request.action) {
    case 'panel':
      return runPanel(request, context);
    case 'status_configuration':
      return describeConfiguration(await context.coordinator.readConfigurationStatus());
    case 'status_member':
      return runMemberStatus(request, context);
    case 'approve':
      return runApprove(request, context);
    case 'reset':
      return runReset(request, context);
    case 'pause':
      return runPause(request, context);
    case 'resume':
      return describeResume(
        await context.coordinator.resumeVerification({
          operationId: request.interaction.id,
          actorId: request.actor.userId,
        }),
      );
    case 'delete_data':
      return runDeleteData(request, context);
  }
}

async function runPanel(request: StaffRequest, context: JourneyContext): Promise<string> {
  const channelId = request.interaction.options.get('channel');
  if (channelId !== context.config.verificationChannelId) {
    return 'The panel belongs in the configured verification channel.';
  }
  const result = await context.coordinator.requestPanel({
    operationId: request.interaction.id,
    channelId,
  });
  return result.kind === 'queued' ? 'The panel update is queued.' : ALREADY_HANDLED;
}

function describeRoleWork(status: MemberStatus): string {
  const job = status.latestRoleJob;
  if (job === null) return 'none';
  switch (job.state) {
    case 'queued':
    case 'running':
      return `${job.kind} pending`;
    case 'unresolved':
      return `${job.kind} unresolved`;
    default:
      return `${job.kind} ${job.result ?? job.state}`;
  }
}

async function runMemberStatus(request: StaffRequest, context: JourneyContext): Promise<string> {
  const { target } = request;
  if (target === null) return 'A member is required.';
  const status = await context.coordinator.readMemberStatus(target.userId);
  return [
    `Member: <@${target.userId}>`,
    `In server: ${target.member === null ? 'no' : 'yes'}`,
    `Session: ${status.sessionState ?? 'none'}`,
    `Role work: ${describeRoleWork(status)}`,
    `Roles visible now: ${String(target.member?.roleIds.length ?? 0)}`,
  ].join('\n');
}

function describeConfiguration(status: ConfigurationStatus): string {
  return [
    `Automatic admission: ${status.paused ? 'paused' : 'running'}`,
    ...(status.pauseReason === null ? [] : [`Pause reason: ${status.pauseReason}`]),
    `Queued jobs: ${String(status.queuedJobs)}`,
    `Unresolved jobs: ${String(status.unresolvedJobs)}`,
    `Unresolved log events: ${String(status.unresolvedLogEvents)}`,
    `Panel posted: ${status.panelConfigured ? 'yes' : 'no'}`,
  ].join('\n');
}

async function runApprove(request: StaffRequest, context: JourneyContext): Promise<string> {
  const { interaction, target } = request;
  const reason = readReason(interaction);
  if (target === null || reason === null) return MEMBER_AND_REASON;
  if (target.member === null) return 'That member is not in the server.';

  const decision = decideAdmission({
    member: target.member,
    accessRoleId: context.config.memberRoleId,
    punitiveRoleIds: context.config.punitiveRoleIds,
    paused: false,
    nowMs: Date.now(),
    mode: 'staff_override',
  });
  if (decision.outcome === 'already_admitted') {
    // pending reset still shows the role, and would remove it unless this approval supersedes it
    const status = await context.coordinator.readMemberStatus(target.userId);
    if (status.desiredRole !== 'absent') return 'That member already has access.';
  }
  if (decision.outcome === 'blocked') return `That member is blocked: ${decision.reason}.`;

  const result = await context.coordinator.approveMember({
    operationId: interaction.id,
    userId: target.userId,
    joinedAtMs: target.member.joinedAtMs,
    actorId: request.actor.userId,
    reason,
  });
  return result.kind === 'queued' ? 'Approval queued.' : ALREADY_HANDLED;
}

async function runReset(request: StaffRequest, context: JourneyContext): Promise<string> {
  const { interaction, target } = request;
  const reason = readReason(interaction);
  if (target === null || reason === null) return MEMBER_AND_REASON;

  const result = await context.coordinator.resetMember({
    operationId: interaction.id,
    userId: target.userId,
    joinedAtMs: target.member?.joinedAtMs ?? null,
    actorId: request.actor.userId,
    reason,
  });
  switch (result.kind) {
    case 'duplicate':
      return ALREADY_HANDLED;
    case 'queued':
      return 'Reset queued. Use /verification status to see when removal is observed.';
    case 'queued_with_uncertainty':
      return 'Reset queued. An earlier role change has an unknown outcome, so removal is being watched for a late effect.';
  }
}

async function runPause(request: StaffRequest, context: JourneyContext): Promise<string> {
  const reason = readReason(request.interaction);
  if (reason === null) return 'A reason of 1 to 500 characters is required.';
  const result = await context.coordinator.pauseVerification({
    operationId: request.interaction.id,
    actorId: request.actor.userId,
    reason,
  });
  return result.kind === 'queued' ? 'Automatic admission is paused.' : ALREADY_HANDLED;
}

function describeResume(result: ResumeResult): string {
  switch (result.kind) {
    case 'resumed':
      return 'Automatic admission resumed.';
    case 'duplicate':
      return ALREADY_HANDLED;
    case 'superseded':
      return 'A newer pause arrived during preflight, so admission stays paused.';
    case 'preflight_unavailable':
      return 'Preflight could not reach Discord, so admission stays paused. Try again shortly.';
    case 'preflight_failed':
      return `Preflight failed, so admission stays paused: ${result.codes.join(', ')}`;
  }
}

async function runDeleteData(request: StaffRequest, context: JourneyContext): Promise<string> {
  const { interaction, target } = request;
  if (target === null || readReason(interaction) === null) return MEMBER_AND_REASON;

  // reason is required as a deliberate step but never stored, it could re-identify the subject
  const result = await context.coordinator.eraseMember({
    operationId: interaction.id,
    userId: target.userId,
    actorId: request.actor.userId,
  });
  return result.kind === 'queued'
    ? 'Erasure started. Log copies are removed as cleanup completes. Server access is unchanged.'
    : ALREADY_HANDLED;
}
