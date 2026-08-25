/**
 * The MIME encoding, which is the part that silently corrupts mail if it is wrong. The API
 * call itself is exercised against the real account by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHeader, toRawMessage } from './gmail-draft.ts';

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

test('an ASCII subject is left exactly as written', () => {
  assert.equal(encodeHeader('Backend Intern - 8 ms latency'), 'Backend Intern - 8 ms latency');
});

test('a subject with real punctuation is RFC 2047 encoded', () => {
  // The model writes en dashes and curly quotes, and job titles are full of them. Put on the
  // wire unencoded they arrive as mojibake in the one line a recruiter sees first.
  const encoded = encodeHeader('Software Engineer Intern – 8 ms typeahead latency');
  assert.match(encoded, /^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);
  assert.equal(
    Buffer.from(encoded.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'),
    'Software Engineer Intern – 8 ms typeahead latency',
  );
});

test('the message is a valid RFC 5322 document', () => {
  const raw = decode(toRawMessage({ to: 'hr@acme.com', subject: 'Hello', body: 'Hi there.\n\nUtkarsh' }));

  assert.match(raw, /^To: hr@acme\.com\r\n/);
  assert.match(raw, /\r\nSubject: Hello\r\n/);
  assert.match(raw, /\r\nContent-Type: text\/plain; charset="UTF-8"\r\n/);
  // Exactly one blank line between headers and body, or the first paragraph becomes a header.
  assert.match(raw, /\r\n\r\nHi there\.\n\nUtkarsh$/);
});

test('the From header is included only when given', () => {
  assert.ok(!decode(toRawMessage({ to: 'a@b.com', subject: 's', body: 'b' })).includes('From:'));
  assert.match(
    decode(toRawMessage({ to: 'a@b.com', subject: 's', body: 'b', from: 'me@x.com' })),
    /\r\nFrom: me@x\.com\r\n/,
  );
});

test('a unicode body survives the round trip', () => {
  const body = 'Hi — I built a p95 8 ms service. Regards,\nUtkarsh Pathak';
  assert.ok(decode(toRawMessage({ to: 'a@b.com', subject: 's', body })).endsWith(body));
});

test('the encoding is base64url, which is what the Gmail API accepts', () => {
  // Standard base64 would put + and / in a URL-encoded field and Gmail would reject it.
  const raw = toRawMessage({ to: 'a@b.com', subject: '~~~ ??? ###', body: 'x'.repeat(200) });
  assert.ok(!raw.includes('+') && !raw.includes('/') && !raw.includes('='));
});
