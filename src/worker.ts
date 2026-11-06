import { ROUTES } from '../shared/browser-contract';
import {
  handleChallengeSubmit,
  handleEntryExchange,
  handleOAuthCallback,
  handleOAuthStart,
  handleStatus,
} from './admission/member-journey';
import type { JourneyContext } from './admission/member-journey';
import { importSigningKey } from './crypto/capability-tokens';
import { readConfig } from './deployment-config';
import type { AppConfig } from './deployment-config';
import {
  errorResponse,
  externalRedirectResponse,
  jsonResponse,
  methodNotAllowedResponse,
  notFoundResponse,
} from './http/secure-responses';
import { handleDiscordInteraction } from './interactions/interaction-endpoint';

export { VerificationCoordinator } from './coordinator/verification-coordinator';

type RouteHandler = (request: Request, context: JourneyContext) => Promise<Response>;
type RouteMethods = Readonly<Record<string, RouteHandler>>;

const API_ROUTES: Readonly<Record<string, RouteMethods>> = {
  [ROUTES.session]: { GET: handleStatus, POST: handleEntryExchange },
  [ROUTES.oauthStart]: { POST: handleOAuthStart },
  [ROUTES.oauthCallback]: { GET: handleOAuthCallback },
  [ROUTES.verify]: { POST: handleChallengeSubmit },
  [ROUTES.interactions]: { POST: handleDiscordInteraction },
};

function unavailableResponse(): Response {
  return errorResponse(503, {
    code: 'unavailable',
    message: 'The service is temporarily unavailable.',
  });
}

async function createContext(
  config: AppConfig,
  env: Env,
  execution: ExecutionContext,
): Promise<JourneyContext | null> {
  const signingKey = await importSigningKey(config.capabilitySigningKey);
  if (signingKey === null) return null;
  return {
    config,
    signingKey,
    coordinator: env.VERIFICATION.get(env.VERIFICATION.idFromName(config.guildId)),
    execution,
  };
}

async function route(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  const result = readConfig(env as unknown as Readonly<Record<string, unknown>>);

  if (pathname === ROUTES.health) {
    return jsonResponse({
      status: result.ok ? 'ok' : 'misconfigured',
      release: result.ok ? result.config.release : 'unknown',
    });
  }
  if (!result.ok) {
    console.error(
      JSON.stringify({ event: 'configuration_invalid', detail: result.invalid.join(',') }),
    );
    return unavailableResponse();
  }

  if (pathname === ROUTES.source) return externalRedirectResponse(result.config.sourceUrl);
  if (pathname === ROUTES.support) return externalRedirectResponse(result.config.supportUrl);

  const methods = API_ROUTES[pathname];
  if (methods === undefined) return notFoundResponse();
  const handler = methods[request.method];
  if (handler === undefined) return methodNotAllowedResponse(Object.keys(methods));

  const context = await createContext(result.config, env, execution);
  return context === null ? unavailableResponse() : handler(request, context);
}

export default {
  async fetch(request, env, execution): Promise<Response> {
    try {
      return await route(request, env, execution);
    } catch {
      // provider errors never reach the response or the log, the path alone is safe to record
      console.error(
        JSON.stringify({ event: 'request_failed', detail: new URL(request.url).pathname }),
      );
      return unavailableResponse();
    }
  },
} satisfies ExportedHandler<Env>;
