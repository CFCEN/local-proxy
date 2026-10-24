import type { FastifyBaseLogger } from 'fastify';

export type ChannelRegistration = {
  sessionId: string;
  cliPid: number;
  port: number;
};

type ChannelEndpoint = ChannelRegistration & { url: string };

export function createChannelRegistry(logger: FastifyBaseLogger) {
  const bySession = new Map<string, ChannelEndpoint>();
  const byPid = new Map<number, string>();

  function register(cliPid: number, port: number): string | undefined {
    const sessionId = byPid.get(cliPid);
    if (!sessionId || !Number.isInteger(port) || port <= 0) return undefined;
    const endpoint = { sessionId, cliPid, port, url: `http://127.0.0.1:${port}/message` };
    bySession.set(sessionId, endpoint);
    logger.info({ sessionId, cliPid, port }, 'Claude Channel registered');
    return sessionId;
  }

  function bindSession(sessionId: string, cliPid?: number) {
    if (!Number.isInteger(cliPid) || !cliPid || cliPid <= 0) return;
    byPid.set(cliPid, sessionId);
    logger.info({ sessionId, cliPid }, 'Claude session process registered');
  }

  function unbindSession(sessionId: string, cliPid?: number) {
    const endpoint = bySession.get(sessionId);
    if (!cliPid || endpoint?.cliPid === cliPid) bySession.delete(sessionId);
    if (cliPid && byPid.get(cliPid) === sessionId) byPid.delete(cliPid);
  }

  function has(sessionId: string) {
    return bySession.has(sessionId);
  }

  async function send(sessionId: string, content: string) {
    const endpoint = bySession.get(sessionId);
    if (!endpoint) return false;
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`Channel returned HTTP ${response.status}`);
      return true;
    } catch (error) {
      logger.warn({ error, sessionId }, 'Claude Channel message failed');
      throw error;
    }
  }

  return { bindSession, has, register, send, unbindSession };
}

export type ChannelRegistry = ReturnType<typeof createChannelRegistry>;
