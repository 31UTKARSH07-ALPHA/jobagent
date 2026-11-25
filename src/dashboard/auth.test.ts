import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../store/db.ts';
import { dashboardConfig, hostedDbPath } from './auth.ts';
import { dashboardServer } from './server.ts';

const origin = 'https://workspace.example.org';
const host = 'workspace.example.org';
const setupToken = randomBytes(32).toString('base64url');
const password = 'test owner passphrase';
const env = { JOBAGENT_DASHBOARD_MODE: 'hosted', JOBAGENT_DASHBOARD_ORIGIN: origin, JOBAGENT_DASHBOARD_SETUP_TOKEN: setupToken };
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();

type Response = { status: number; headers: IncomingHttpHeaders; body: string };
function http(server: Server, path: string, { method = 'GET', headers = {}, body }: {
  method?: string; headers?: Record<string, string>; body?: string;
} = {}): Promise<Response> {
  const { port } = server.address() as { port: number };
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (part: string) => { body += part; });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const stop = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const postForm = (server: Server, path: string, data: Record<string, string>, headers = {}) =>
  http(server, path, { method: 'POST', body: form(data), headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...headers } });
const cookiePair = (response: Response) => response.headers['set-cookie']?.[0]?.split(';')[0] ?? '';

test('hosted config fails closed for missing or unsafe settings', () => {
  assert.equal(dashboardConfig(4317, {}).hosted, false);
  for (const invalid of [
    { JOBAGENT_DASHBOARD_MODE: 'hosted' },
    { JOBAGENT_DASHBOARD_MODE: '' },
    { JOBAGENT_DASHBOARD_ORIGIN: '' },
    { JOBAGENT_DASHBOARD_ORIGIN: 'http://workspace.example.org' },
    { JOBAGENT_DASHBOARD_ORIGIN: `${origin}/` },
    { JOBAGENT_DASHBOARD_ORIGIN: `${origin}/workspace` },
    { JOBAGENT_DASHBOARD_ORIGIN: 'https://password@workspace.example.org' },
    { JOBAGENT_DASHBOARD_SETUP_TOKEN: setupToken },
    { ...env, JOBAGENT_DASHBOARD_MODE: 'local' },
    { ...env, JOBAGENT_DASHBOARD_SETUP_TOKEN: 'short' },
    { ...env, JOBAGENT_SEND: 'armed' },
    { JOBAGENT_DASHBOARD_BIND: '0.0.0.0' },
  ]) assert.throws(() => dashboardConfig(4317, invalid));
  assert.equal(dashboardConfig(4317, { ...env, JOBAGENT_DASHBOARD_BIND: '0.0.0.0' }).bind, '0.0.0.0');
  assert.equal(dashboardConfig(4317, { JOBAGENT_DASHBOARD_ORIGIN: origin }).hosted, true);
  assert.throws(() => hostedDbPath(undefined));
  assert.throws(() => hostedDbPath('data/jobagent.db'));
  assert.throws(() => hostedDbPath(resolve('data/jobagent.db')));

  const db = openDb(':memory:');
  try {
    assert.throws(() => dashboardServer(db, 0, dashboardConfig(0, { JOBAGENT_DASHBOARD_ORIGIN: origin })), /SETUP_TOKEN/);
  } finally { db.close(); }
});

test('hosted pages and data require the singleton owner session, including after server restart', async () => {
  const db = openDb(':memory:');
  let server = dashboardServer(db, 0, dashboardConfig(0, env));
  await listen(server);
  const account = { email: 'Owner@Example.org', password, setupToken };
  try {
    assert.equal((await http(server, '/')).status, 200);
    assert.match((await http(server, '/')).body, /See how it works/);
    assert.equal((await http(server, '/landing.css')).status, 200);
    assert.equal((await http(server, '/auth.css')).status, 200);
    assert.match((await http(server, '/login')).body, /name="password"/);
    assert.match((await http(server, '/signup')).body, /name="setupToken"/);
    const privatePage = await http(server, '/workspace');
    assert.equal(privatePage.status, 303);
    assert.equal(privatePage.headers.location, '/login');
    for (const path of ['/index.html', '/app.js', '/style.css', '/learning.js', '/learning.css', '/api/dashboard', '/api/replies', '/api/learning', '/api/interview-prep/1', '/future-private-route']) {
      assert.equal((await http(server, path)).status, 401, path);
    }
    assert.equal((await http(server, '/api/dashboard', { method: 'HEAD' })).status, 401);
    assert.equal((await http(server, '/', { headers: { host: 'wrong.example.org', 'x-forwarded-host': host } })).status, 403);
    assert.equal((await postForm(server, '/signup', account, { origin: 'https://other.example.org' })).status, 403);
    assert.equal((await postForm(server, '/signup', account, { origin: 'null' })).status, 403);
    assert.equal((await postForm(server, '/signup', { ...account, setupToken: 'x'.repeat(43) })).status, 403);
    const signupAttempts = await Promise.all([postForm(server, '/signup', account), postForm(server, '/signup', account)]);
    assert.deepEqual(signupAttempts.map((response) => response.status).sort(), [303, 409]);
    const signup = signupAttempts.find((response) => response.status === 303)!;
    assert.equal(signup.headers.location, '/workspace');
    assert.equal(signup.headers['cache-control'], 'no-store');
    assert.match(String(signup.headers['strict-transport-security']), /max-age=/);
    assert.match(signup.headers['set-cookie']![0]!, /^__Host-jobagent_session=[\w-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800$/);
    const signedUpCookie = cookiePair(signup);
    const accountRow = db.prepare('SELECT email, password_hash FROM dashboard_owner').get()!;
    assert.equal(accountRow.email, 'owner@example.org');
    assert.match(String(accountRow.password_hash), /^scrypt-v1:[a-f\d]{32}:[a-f\d]{128}$/);
    assert.notEqual(db.prepare('SELECT token_hash FROM dashboard_sessions').get()?.token_hash, signedUpCookie.split('=')[1]);
    assert.doesNotMatch((await http(server, '/signup')).body, /name="setupToken"/);
    assert.equal((await postForm(server, '/signup', { ...account, email: 'other@example.org' })).status, 409);
    assert.equal((await http(server, '/api/dashboard', { headers: { cookie: '__Host-jobagent_session=' + 'a'.repeat(43) } })).status, 401);
    const signedUp = { cookie: signedUpCookie };
    assert.equal((await http(server, '/workspace', { headers: signedUp })).status, 200);
    assert.equal((await http(server, '/app.js', { headers: signedUp })).status, 200);
    assert.equal(JSON.parse((await http(server, '/api/dashboard', { headers: signedUp })).body).sendingArmed, false);
    assert.deepEqual(JSON.parse((await http(server, '/api/auth/session', { headers: signedUp })).body), { authenticated: true, email: 'owner@example.org' });
    assert.equal((await http(server, '/api/replies', { headers: signedUp })).status, 503);
    for (const action of ['review', 'quality', 'send', 'delete']) {
      assert.equal((await http(server, `/api/drafts/1/${action}`, { method: 'POST', headers: { ...signedUp, origin, 'x-jobagent-action': action } })).status, 503);
    }
    assert.equal((await http(server, '/api/learning/1/generate', { method: 'POST', headers: { ...signedUp, origin, 'x-jobagent-action': 'generate' } })).status, 503);
    assert.equal((await http(server, '/logout', { method: 'POST', headers: signedUp })).status, 403);
    assert.equal((await http(server, '/logout', { headers: signedUp })).status, 404);

    await stop(server);
    server = dashboardServer(db, 0, dashboardConfig(0, { JOBAGENT_DASHBOARD_ORIGIN: origin }));
    await listen(server);
    assert.equal((await http(server, '/api/dashboard', { headers: signedUp })).status, 200);
    const login = await postForm(server, '/login', account, signedUp);
    assert.equal(login.status, 303);
    assert.notEqual(cookiePair(login), signedUpCookie);
    assert.equal((await http(server, '/api/dashboard', { headers: signedUp })).status, 401);
    const relogged = { cookie: cookiePair(login), origin };
    assert.equal((await http(server, '/api/dashboard', { headers: relogged })).status, 200);
    const logout = await http(server, '/logout', { method: 'POST', headers: relogged });
    assert.equal(logout.status, 303);
    assert.equal(logout.headers.location, '/');
    assert.match(logout.headers['set-cookie']![0]!, /Max-Age=0$/);
    assert.equal((await http(server, '/api/dashboard', { headers: relogged })).status, 401);
    const next = await postForm(server, '/login', account);
    db.prepare('UPDATE dashboard_sessions SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await http(server, '/api/dashboard', { headers: { cookie: cookiePair(next) } })).status, 401);
  } finally { await stop(server); db.close(); }
});

test('throttles setup and logins regardless of credentials or forwarded address', async () => {
  const db = openDb(':memory:');
  let server = dashboardServer(db, 0, dashboardConfig(0, env));
  await listen(server);
  try {
    for (let i = 1; i <= 5; i++) assert.equal((await postForm(server, '/signup', {}, { 'x-forwarded-for': `192.0.2.${i}` })).status, 400);
    const tooMany = await postForm(server, '/signup', { email: 'owner@example.org', password, setupToken });
    assert.equal(tooMany.status, 429);
    assert.ok(Number(tooMany.headers['retry-after']) > 0);
    await stop(server);
    server = dashboardServer(db, 0, dashboardConfig(0, env));
    await listen(server);
    assert.equal((await postForm(server, '/signup', {})).status, 429);
    db.exec('UPDATE dashboard_auth_limits SET window_ends_at = 0');
    assert.equal((await postForm(server, '/signup', { email: 'owner@example.org', password, setupToken })).status, 303);
    for (let i = 1; i <= 10; i++) assert.equal((await postForm(server, '/login', {}, { 'x-forwarded-for': `192.0.2.${i}` })).status, 400);
    assert.equal((await postForm(server, '/login', { email: 'owner@example.org', password })).status, 429);
  } finally { await stop(server); db.close(); }
});

test('local loopback keeps the root workspace and denies proxy-looking requests', async () => {
  const db = openDb(':memory:');
  const config = dashboardConfig(4317, {});
  const server = dashboardServer(db, 4317, config);
  await listen(server);
  try {
    const headers = { host: config.host };
    assert.equal((await http(server, '/', { headers })).status, 200);
    assert.equal((await http(server, '/workspace', { headers })).status, 200);
    assert.equal((await http(server, '/landing', { headers })).status, 200);
    assert.equal((await http(server, '/login', { headers })).headers.location, '/workspace');
    assert.equal((await http(server, '/api/dashboard', { headers })).status, 200);
    assert.equal((await http(server, '/api/dashboard', { headers: { ...headers, 'x-forwarded-host': config.host } })).status, 403);
    assert.equal((await http(server, '/api/dashboard', { headers: { host: 'wrong.example.org' } })).status, 403);
  } finally { await stop(server); db.close(); }
});
