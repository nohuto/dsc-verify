// signature covers the raw bytes, nothing is parsed before it verifies, PING needs no guild fields

import { VERIFY_BUTTON_CUSTOM_ID } from '../../shared/slash-commands';
import type { JourneyContext } from '../admission/member-journey';
import { verifyInteractionSignature } from '../crypto/interaction-signature';
import type { AppConfig } from '../deployment-config';
import { MAX_DISCORD_BODY_BYTES, parseJson, readBoundedBody } from '../http/bounded-body';
import { errorResponse } from '../http/secure-responses';
import { decodeInteraction } from '../providers/discord-interactions';
import type { CommandInteraction, ComponentInteraction } from '../providers/discord-interactions';
import { ephemeralReply, pongReply } from './interaction-replies';
import { startMemberVerification } from './member-verify';
import { handleStaffCommand } from './staff-commands';

const GUILD_INTERACTION_CONTEXT = 0;

function invalidSignatureResponse(): Response {
  return errorResponse(401, { code: 'forbidden', message: 'Invalid request signature.' });
}

// guild installation key decides, a member who also installed the app personally is still in the
// guild, and context is documented as optional
function isConfiguredGuildContext(
  interaction: CommandInteraction | ComponentInteraction,
  config: AppConfig,
): boolean {
  return (
    interaction.applicationId === config.applicationId &&
    interaction.guildId === config.guildId &&
    (interaction.context === null || interaction.context === GUILD_INTERACTION_CONTEXT) &&
    interaction.guildInstallOwner === config.guildId
  );
}

export async function handleDiscordInteraction(
  request: Request,
  context: JourneyContext,
): Promise<Response> {
  const body = await readBoundedBody(request, MAX_DISCORD_BODY_BYTES);
  if (!body.ok) {
    return errorResponse(413, { code: 'invalid_request', message: 'Request too large.' });
  }

  const signature = await verifyInteractionSignature({
    publicKeyHex: context.config.publicKeyHex,
    signatureHex: request.headers.get('X-Signature-Ed25519'),
    timestamp: request.headers.get('X-Signature-Timestamp'),
    body: body.bytes,
    nowMs: Date.now(),
  });
  if (!signature.ok) return invalidSignatureResponse();

  const parsed = parseJson(body.bytes);
  const interaction = parsed.ok ? decodeInteraction(parsed.value) : null;
  if (interaction === null) {
    return errorResponse(400, { code: 'invalid_request', message: 'Malformed interaction.' });
  }

  switch (interaction.type) {
    case 'ping':
      return pongReply();
    case 'unsupported':
      return ephemeralReply({ content: 'That interaction is not supported.' });
    case 'command':
    case 'component':
  }

  if (!isConfiguredGuildContext(interaction, context.config)) {
    return ephemeralReply({ content: 'This only works inside the configured server.' });
  }
  const { member } = interaction;
  if (member === null) return ephemeralReply({ content: 'This only works inside the server.' });

  if (interaction.type === 'component') {
    if (interaction.customId !== VERIFY_BUTTON_CUSTOM_ID) {
      return ephemeralReply({ content: 'That control is not supported.' });
    }
    return startMemberVerification({ operationId: interaction.id, member }, context);
  }

  switch (interaction.commandName) {
    case 'verify':
      return startMemberVerification({ operationId: interaction.id, member }, context);
    case 'verification':
      return handleStaffCommand(interaction, member, context);
    default:
      return ephemeralReply({ content: 'Unknown command.' });
  }
}
