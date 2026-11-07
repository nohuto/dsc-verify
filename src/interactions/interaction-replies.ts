import { jsonResponse } from '../http/secure-responses';

const INTERACTION_PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
const EPHEMERAL_FLAG = 1 << 6;

type ReplyData = {
  readonly content: string;
  readonly components?: readonly unknown[];
};

export function pongReply(): Response {
  return jsonResponse({ type: INTERACTION_PONG });
}

export function ephemeralReply(data: ReplyData): Response {
  return jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { ...data, flags: EPHEMERAL_FLAG, allowed_mentions: { parse: [] } },
  });
}

export function deferredEphemeralReply(): Response {
  return jsonResponse({
    type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: EPHEMERAL_FLAG },
  });
}
