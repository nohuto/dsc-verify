import { digestToken, randomToken } from './canonical-encoding';

export async function createPkcePair(): Promise<{
  readonly verifier: string;
  readonly challenge: string;
}> {
  const verifier = randomToken();
  return { verifier, challenge: await computePkceChallenge(verifier) };
}

export function computePkceChallenge(verifier: string): Promise<string> {
  return digestToken(verifier);
}
