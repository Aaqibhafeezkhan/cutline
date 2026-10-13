import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { CutlineConfig } from '../config';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Hostnames accepted in Host/Origin headers (DNS-rebinding protection). */
export function allowedHostnames(config: CutlineConfig): Set<string> {
  const set = new Set([...LOOPBACK, ...config.allowedHosts]);
  if (!['0.0.0.0', '::', ''].includes(config.host)) set.add(config.host.toLowerCase());
  return set;
}

function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const url = new URL(req.url ?? '/', 'http://x');
  return url.searchParams.get('token');
}

/**
 * Checks Host, Origin and (optionally) the bearer token. Returns an error
 * message or null when the request is allowed.
 */
export function checkRequest(
  req: IncomingMessage,
  config: CutlineConfig,
  hosts: Set<string>,
): string | null {
  const host = hostnameOf(req.headers.host);
  if (!host || !hosts.has(host)) {
    return `Host "${req.headers.host ?? ''}" is not allowed. Add it to CUTLINE_ALLOWED_HOSTS.`;
  }
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    const o = hostnameOf(origin);
    if (!o || !hosts.has(o)) return `Origin "${origin}" is not allowed.`;
  }
  if (config.token && !tokenMatches(config.token, requestToken(req))) {
    return 'Missing or invalid token. Send "Authorization: Bearer <CUTLINE_TOKEN>".';
  }
  return null;
}

export function securityMiddleware(config: CutlineConfig) {
  const hosts = allowedHostnames(config);
  return (req: Request, res: Response, next: NextFunction) => {
    // The health check stays public so tooling can find the server.
    if (req.path === '/api/health' && !config.token) return next();
    const problem = checkRequest(req, config, hosts);
    if (problem) {
      const status = problem.startsWith('Missing or invalid token') ? 401 : 403;
      res
        .status(status)
        .json({ error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message: problem } });
      return;
    }
    next();
  };
}
