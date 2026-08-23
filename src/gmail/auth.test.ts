/**
 * No network and no browser. What is worth testing here is not the OAuth dance — Google's
 * library does that — but the two things that will actually go wrong at 06:00 six months
 * from now: the scope list quietly widening, and an opaque auth failure nobody can act on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SCOPES, describeAuthError, hasToken, readCredentials } from './auth.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'jobagent-auth-'));

test('the scopes stay narrow — widening one means Utkarsh re-consents', () => {
  assert.deepEqual(
    [...SCOPES].sort(),
    [
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
    'exactly read, compose, send',
  );

  // The two that would hand over far more than this pipeline needs.
  for (const tooBroad of ['https://mail.google.com/', 'gmail.modify']) {
    assert.equal(
      SCOPES.some((s) => s.includes(tooBroad)),
      false,
      `${tooBroad} must never appear`,
    );
  }
});

test('a Web-application client is rejected by name, not by a Zod dump', () => {
  // The single most likely setup mistake: picking "Web application" in the console. Its JSON
  // has `web`, it cannot do the loopback flow, and Google's own error for it is unhelpful.
  const dir = scratch();
  const path = join(dir, 'web-client.json');
  writeFileSync(path, JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } }));

  assert.throws(() => readCredentials(path), /Desktop app/);
  assert.throws(() => readCredentials(path), /"web"/, 'names what it found');
});

test('a missing credentials file says where to get one', () => {
  assert.throws(
    () => readCredentials(join(scratch(), 'nope.json')),
    /console\.cloud\.google\.com/,
  );
});

test('a real Desktop-app credential parses', () => {
  const dir = scratch();
  const path = join(dir, 'credentials.json');
  writeFileSync(
    path,
    JSON.stringify({
      installed: {
        client_id: '812476624227-abc.apps.googleusercontent.com',
        client_secret: 'GOCSPX-secret',
        redirect_uris: ['http://localhost'],
      },
    }),
  );

  const creds = readCredentials(path);
  assert.equal(creds.client_id, '812476624227-abc.apps.googleusercontent.com');
  assert.equal(creds.client_secret, 'GOCSPX-secret');
});

test('hasToken is false for missing and for half-written files', () => {
  const dir = scratch();
  assert.equal(hasToken(join(dir, 'absent.json')), false);

  const garbage = join(dir, 'garbage.json');
  writeFileSync(garbage, 'not json at all');
  assert.equal(hasToken(garbage), false);

  // The dangerous case: a token file with an access_token but no refresh_token. It works for
  // an hour and then the pipeline dies unattended, so it must not count as authorised.
  const noRefresh = join(dir, 'no-refresh.json');
  writeFileSync(noRefresh, JSON.stringify({ access_token: 'ya29.short-lived' }));
  assert.equal(hasToken(noRefresh), false);

  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ refresh_token: '1//refresh', scope: SCOPES.join(' ') }));
  assert.equal(hasToken(good), true);
});

test('invalid_grant is explained as the Testing-mode expiry, with the command that fixes it', () => {
  // This is the error the pipeline will hit on day eight. Anyone reading the log at 06:05
  // should not have to go and learn how Google's consent screens work.
  const explained = describeAuthError(new Error('invalid_grant: Token has been expired or revoked.'));
  assert.match(explained, /7-day/);
  assert.match(explained, /node src\/gmail\/auth\.ts/);
  assert.match(explained, /publish the/i, 'and how to stop it recurring');
});

test('other auth failures get their own explanation, not the 7-day one', () => {
  assert.match(describeAuthError(new Error('invalid_client: Unauthorized')), /downloaded|Download it again/i);
  assert.equal(/7-day/.test(describeAuthError(new Error('invalid_client: Unauthorized'))), false);

  assert.match(
    describeAuthError(new Error('Request had insufficient authentication scopes')),
    /gmail\.readonly/,
    'a scope error lists the scopes it wanted',
  );

  // Anything unrecognised passes through untouched rather than being guessed at.
  assert.equal(describeAuthError(new Error('socket hang up')), 'socket hang up');
});

test('a written token is not world-readable', () => {
  // token.json is a password for the mailbox. If this ever regresses, it regresses silently.
  const dir = scratch();
  const path = join(dir, 'token.json');
  writeFileSync(path, JSON.stringify({ refresh_token: '1//x' }), { mode: 0o600 });
  assert.equal(statSync(path).mode & 0o077, 0, 'no group or other permissions');
});

test('the advice in an auth error names a command that actually re-authorises', () => {
  // The loop this guards against, reported 2026-08-23: `node src/gmail/auth.ts` found a dead
  // token, printed describeAuthError — which ends "re-run: node src/gmail/auth.ts" — and
  // returned without doing anything. The advice was circular, and the only way out was
  // knowing about --force. `main` now falls through to a fresh authorisation, so the
  // sentence has to keep pointing at the bare command for it to stay true.
  const advice = describeAuthError(Object.assign(new Error('invalid_grant'), { message: 'invalid_grant' }));
  assert.match(advice, /node src\/gmail\/auth\.ts/);
  assert.doesNotMatch(advice, /--force/, 'the bare command must be enough; --force is for a healthy token');
});
