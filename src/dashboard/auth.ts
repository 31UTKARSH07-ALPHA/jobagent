import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { transaction, type Db } from '../store/db.ts';
import { authPage } from './auth-page.ts';

const cookieName = '__Host-jobagent_session';
const sessionSeconds = 7 * 24 * 60 * 60;
const limitWindowMs = 15 * 60_000;
const attemptLimits = { login: 10, signup: 5 } as const;
const tokenShape = /^[A-Za-z0-9_-]{43}$/;
const setupTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const scryptOptions = { N: 2 ** 16, r: 8, p: 2, maxmem: 96 * 1024 ** 2 };
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const password = z.string().min(12).max(128).refine((text) => Buffer.byteLength(text) <= 512);
const loginInput = z.object({ email, password });
const signupInput = loginInput.extend({ setupToken: setupTokenSchema });
type Action = keyof typeof attemptLimits;

export function dashboardConfig(port: number, env: NodeJS.ProcessEnv = process.env) {
  const mode = z.enum(['local', 'hosted']).optional().parse(env.JOBAGENT_DASHBOARD_MODE);
  const configuredOrigin = env.JOBAGENT_DASHBOARD_ORIGIN;
  const token = env.JOBAGENT_DASHBOARD_SETUP_TOKEN;
  const bind = env.JOBAGENT_DASHBOARD_BIND ?? '127.0.0.1';
  if (mode !== 'hosted' && configuredOrigin === undefined && token === undefined) {
    if (bind !== '127.0.0.1') throw new Error('Local dashboard must bind to 127.0.0.1. Configure hosted mode for other binds.');
    return { hosted: false, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, bind } as const;
  }
  if (mode === 'local') throw new Error('Hosted auth settings cannot be used in explicit local mode.');
  if (env.JOBAGENT_SEND === 'armed') throw new Error('Sending must be disarmed in hosted dashboard mode.');
  if (bind !== '127.0.0.1' && bind !== '0.0.0.0') throw new Error('Hosted dashboard bind must be 127.0.0.1 or 0.0.0.0.');
  let url: URL;
  try {
    url = new URL(configuredOrigin ?? '');
    if (url.protocol !== 'https:' || url.origin !== configuredOrigin) throw new Error();
  } catch {
    throw new Error('Hosted dashboard requires JOBAGENT_DASHBOARD_ORIGIN to be an exact HTTPS origin without a trailing slash.');
  }
  if (token !== undefined && !setupTokenSchema.safeParse(token).success) {
    throw new Error('JOBAGENT_DASHBOARD_SETUP_TOKEN must be a 32–128 character base64url secret.');
  }
  return { hosted: true, host: url.host, origin: url.origin, bind, setupDigest: token === undefined ? undefined : digest(token) } as const;
}

export function hostedDbPath(path: string | undefined) {
  if (!path || !isAbsolute(path)) throw new Error('Hosted dashboard requires an explicit, separate absolute JOBAGENT_DB path.');
  const target = resolve(path);
  const defaults = [fileURLToPath(new URL('../../data/jobagent.db', import.meta.url)), resolve('data/jobagent.db')];
  const stat = (file: string) => statSync(file, { throwIfNoEntry: false });
  const candidate = stat(target);
  if (defaults.includes(target) ||
      (candidate && defaults.some((file) => {
        const local = stat(file);
        return local && local.dev === candidate.dev && local.ino === candidate.ino;
      }))) {
    throw new Error('Hosted dashboard must not use the default local jobagent.db file.');
  }
  return target;
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const randomToken = () => randomBytes(32).toString('base64url');

function derive(text: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(text, salt, 64, scryptOptions, (err, key) => err ? reject(err) : resolve(key));
  });
}

async function hashPassword(text: string) {
  const salt = randomBytes(16);
  return `scrypt-v1:${salt.toString('hex')}:${(await derive(text, salt)).toString('hex')}`;
}

async function checkPassword(text: string, hash: string | undefined) {
  const fields = /^scrypt-v1:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(hash ?? '');
  // Run the same KDF even before first signup, so failed logins have consistent cost.
  const key = await derive(text, fields ? Buffer.from(fields[1]!, 'hex') : Buffer.alloc(16));
  return !!fields && timingSafeEqual(key, Buffer.from(fields[2]!, 'hex'));
}

function sessionToken(req: IncomingMessage) {
  const matches = req.headers.cookie?.split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`));
  const value = matches?.length === 1 ? matches[0]!.slice(cookieName.length + 1) : undefined;
  return value && tokenShape.test(value) ? value : undefined;
}

function cookie(res: ServerResponse, token = '') {
  res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${token ? sessionSeconds : 0}`);
}

export function redirect(res: ServerResponse, path: string) {
  res.writeHead(303, { Location: path });
  res.end();
}

function html(res: ServerResponse, status: number, page: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
}

async function authForm(req: IncomingMessage, res: ServerResponse) {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') return;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > 4096) {
      res.setHeader('Connection', 'close');
      return;
    }
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

export function ownerAuth(db: Db, setupDigest: Buffer | undefined) {
  const owner = db.prepare('SELECT email, password_hash FROM dashboard_owner WHERE id = 1');
  if (!owner.get() && !setupDigest) throw new Error('Set JOBAGENT_DASHBOARD_SETUP_TOKEN before first hosted signup.');
  const lookup = db.prepare(`SELECT o.email FROM dashboard_sessions s JOIN dashboard_owner o ON o.id = s.owner_id
    WHERE s.token_hash = ? AND s.expires_at > ?`);
  const revoke = db.prepare('DELETE FROM dashboard_sessions WHERE token_hash = ?');
  const deleteExpired = db.prepare('DELETE FROM dashboard_sessions WHERE expires_at <= ?');
  const createSession = db.prepare('INSERT INTO dashboard_sessions VALUES (?, 1, ?)');
  const createOwner = db.prepare('INSERT INTO dashboard_owner VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING');
  // One persistent bucket per credential endpoint; do not trust forwarded addresses or let
  // changing an email evade the limit. Single-owner deployments should also use edge limits.
  const takeAttempt = db.prepare(`INSERT INTO dashboard_auth_limits VALUES (?, ?, 1)
    ON CONFLICT(action) DO UPDATE SET
      attempts = CASE WHEN window_ends_at <= ? THEN 1 ELSE attempts + 1 END,
      window_ends_at = CASE WHEN window_ends_at <= ? THEN excluded.window_ends_at ELSE window_ends_at END
    WHERE window_ends_at <= ? OR attempts < ?
    RETURNING window_ends_at`);
  const getLimit = db.prepare('SELECT window_ends_at FROM dashboard_auth_limits WHERE action = ?');
  let deriving = 0;

  function session(req: IncomingMessage) {
    const token = sessionToken(req);
    if (!token) return;
    const row = lookup.get(digest(token).toString('hex'), Date.now());
    return row ? { email: String(row.email) } : undefined;
  }

  function grantSession(req: IncomingMessage) {
    const now = Date.now();
    deleteExpired.run(now);
    const previous = sessionToken(req);
    if (previous) revoke.run(digest(previous).toString('hex'));
    const fresh = randomToken();
    createSession.run(digest(fresh).toString('hex'), now + sessionSeconds * 1000);
    return fresh;
  }

  async function credentials(req: IncomingMessage, res: ServerResponse, action: Action) {
    const signup = action === 'signup';
    const render = (status: number, error?: string, closed = false) => html(res, status, authPage(action, { error, closed }));
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (session(req)) return redirect(res, '/workspace');
      return render(200, undefined, signup && (!setupDigest || !!owner.get()));
    }
    if (signup && (!setupDigest || owner.get())) return render(409, undefined, true);
    if (deriving >= 2) {
      res.setHeader('Retry-After', '1');
      return render(429, 'The server is busy. Try again in a moment.');
    }
    const now = Date.now();
    if (!takeAttempt.get(action, now + limitWindowMs, now, now, now, attemptLimits[action])) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((Number(getLimit.get(action)?.window_ends_at) - now) / 1000))));
      return render(429, 'Too many attempts. Wait a few minutes and try again.');
    }
    // Claim a work slot before yielding to the body stream; the database bucket also
    // persists across restarts and across servers using the same database.
    deriving++;
    try {
      const form = await authForm(req, res);
      if (!form) return render(400, 'Use the on-page form to continue.');
      if (signup) {
        const input = signupInput.safeParse(form);
        if (!input.success) return render(400, 'Enter a valid email, a password of 12–128 characters, and the setup token.');
        if (!timingSafeEqual(digest(input.data.setupToken), setupDigest!)) return render(403, 'The setup token is incorrect.');
        const hash = await hashPassword(input.data.password);
        const token = transaction(db, () => createOwner.run(input.data.email, hash).changes ? grantSession(req) : undefined);
        if (!token) return render(409, undefined, true);
        cookie(res, token);
      } else {
        const input = loginInput.safeParse(form);
        if (!input.success) return render(400, 'Enter a valid email and password.');
        const account = owner.get();
        const valid = await checkPassword(input.data.password, account ? String(account.password_hash) : undefined);
        if (!valid || input.data.email !== account?.email) return render(401, 'The email or password is incorrect.');
        cookie(res, transaction(db, () => grantSession(req)));
      }
      return redirect(res, '/workspace');
    } finally {
      deriving--;
    }
  }

  function logout(req: IncomingMessage, res: ServerResponse) {
    const token = sessionToken(req);
    if (token) revoke.run(digest(token).toString('hex'));
    cookie(res);
    return redirect(res, '/');
  }

  return { session, credentials, logout };
}
