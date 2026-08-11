/**
 * No network. The payloads below are shaped like the real ones, because the failure mode this
 * guards against is not a crash — it is a parser that silently reads an empty body and
 * reports "0 new jobs" every morning while the mail sits there unread.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { gmail_v1 } from '@googleapis/gmail';
import {
  addressOf,
  afterClause,
  bodyOf,
  decodeBody,
  extractLinks,
  headerValue,
  toEmail,
  walkParts,
} from './messages.ts';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** The shape LinkedIn actually sends: multipart/alternative, text and HTML side by side. */
const alternative = (text: string, html: string): gmail_v1.Schema$Message => ({
  id: 'm1',
  threadId: 't1',
  internalDate: '1786291200000',
  labelIds: ['INBOX', 'CATEGORY_UPDATES'],
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>' },
      { name: 'Subject', value: '3 new jobs for “software engineer intern”' },
      { name: 'Date', value: 'Mon, 11 Aug 2026 06:00:00 +0000' },
    ],
    parts: [
      { partId: '0', mimeType: 'text/plain', body: { data: b64(text) } },
      { partId: '1', mimeType: 'text/html', body: { data: b64(html) } },
    ],
  },
});

test('headers are matched case-insensitively, as RFC 2822 allows', () => {
  const part: gmail_v1.Schema$MessagePart = {
    headers: [
      { name: 'from', value: 'a@b.com' },
      { name: 'SUBJECT', value: 'hello' },
    ],
  };
  assert.equal(headerValue(part, 'From'), 'a@b.com');
  assert.equal(headerValue(part, 'subject'), 'hello');
  assert.equal(headerValue(part, 'Missing'), '', 'absent header is empty, never undefined');
  assert.equal(headerValue(undefined, 'From'), '');
});

test('the sender address is pulled out of the display-name form', () => {
  assert.equal(
    addressOf('LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>'),
    'jobalerts-noreply@linkedin.com',
  );
  assert.equal(addressOf('info@naukri.com'), 'info@naukri.com');
  assert.equal(addressOf('"Naukri, Alerts" <Alerts@Naukri.com>'), 'alerts@naukri.com', 'lowercased');
});

test('bodies decode as base64url, not base64', () => {
  // Gmail uses - and _ and drops padding. A plain base64 decode mangles exactly the bytes
  // that appear in tracking URLs, which is where the job links live.
  const tricky = 'https://in.linkedin.com/comm/jobs/view/4321?trk=a+b/c&mid=xyz~';
  assert.equal(decodeBody(b64(tricky)), tricky);
  assert.equal(decodeBody(null), '', 'a container part with no body is not an error');
  assert.equal(decodeBody(undefined), '');
});

test('a multipart/alternative message yields both bodies', () => {
  const msg = alternative(
    'Plain body, and a real one — long enough to beat its own markup.',
    '<p>HTML body</p>',
  );
  const { text, html } = bodyOf(msg.payload);
  assert.match(text, /^Plain body/, 'a genuine text/plain part is used as-is');
  assert.equal(html, '<p>HTML body</p>');
});

test('a stub text/plain part loses to the HTML that holds the actual jobs', () => {
  // The exact shape of a real Naukri Campus alert (2026-08-11): the declared plain-text part
  // is a one-line stub, and all three postings are in the markup. Preferring text/plain here
  // reads the email as empty and reports no jobs, silently, forever.
  const msg = alternative(
    'Job recommendations based on your Naukri.com profile',
    '<a href="https://www.naukri.com/jd/job-listings-sde-intern-acme-bengaluru-0-to-1-years-1">' +
      'Software Development Intern (Full Stack)</a><p>Discover Dollar Tec...</p>' +
      '<p>Internship</p><a href="https://www.naukri.com/jd/job-listings-ml-intern-beta-pune-0-to-2-years-2">' +
      'Python / AI-ML Intern</a><p>Lakkshions It</p>',
  );

  const { text } = bodyOf(msg.payload);
  assert.match(text, /Software Development Intern/, 'the HTML won');
  assert.match(text, /Python \/ AI-ML Intern/);
  assert.equal(text.includes('Job recommendations based on'), false, 'the stub was discarded');
});

test('an HTML-only message still produces readable text', () => {
  // Naukri sends these. Without the fallback the parser sees an empty body and reports
  // nothing, silently.
  const msg: gmail_v1.Schema$Message = {
    id: 'm2',
    internalDate: '1786291200000',
    payload: {
      mimeType: 'text/html',
      headers: [{ name: 'From', value: 'info@naukri.com' }],
      body: { data: b64('<h1>Jobs</h1><li>SDE Intern</li><li>Backend Intern</li>') },
    },
  };

  const { text, html } = bodyOf(msg.payload);
  assert.match(text, /SDE Intern/);
  assert.match(text, /•/, 'list items survive as bullets');
  assert.notEqual(html, '');
});

test('nested multipart is walked to the bottom', () => {
  // multipart/mixed wrapping multipart/alternative — what an alert with an attachment looks
  // like. A one-level-deep search finds no body at all.
  const msg: gmail_v1.Schema$Message = {
    id: 'm3',
    internalDate: '1786291200000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: 'x@y.com' }],
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('buried body') } },
            { mimeType: 'text/html', body: { data: b64('<p>buried</p>') } },
          ],
        },
        { mimeType: 'application/pdf', filename: 'flyer.pdf', body: { attachmentId: 'a1' } },
      ],
    },
  };

  assert.equal(walkParts(msg.payload).length, 5, 'container parts count too');
  assert.equal(bodyOf(msg.payload).text, 'buried body');
});

test('an attachment is never mistaken for the body', () => {
  const msg: gmail_v1.Schema$Message = {
    id: 'm4',
    internalDate: '1786291200000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: 'x@y.com' }],
      parts: [
        // A text/plain *attachment* listed before the real body.
        { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('ATTACHED FILE') } },
        { mimeType: 'text/plain', body: { data: b64('the actual body') } },
      ],
    },
  };
  assert.equal(bodyOf(msg.payload).text, 'the actual body');
});

test('the timestamp comes from internalDate, not the Date header', () => {
  // Senders get the Date header wrong constantly — wrong zone, or absent. internalDate is
  // when Google took delivery, which is what "newer than `since`" has to mean.
  const email = toEmail(alternative('t', '<p>h</p>'));
  assert.equal(email.receivedAt, new Date(1786291200000).toISOString());
  assert.equal(email.fromAddress, 'jobalerts-noreply@linkedin.com');
  assert.match(email.subject, /3 new jobs/);
  assert.deepEqual(email.labelIds, ['INBOX', 'CATEGORY_UPDATES']);
});

test('a message with nothing in it parses instead of throwing', () => {
  const email = toEmail({});
  assert.equal(email.id, '');
  assert.equal(email.text, '');
  assert.ok(Date.parse(email.receivedAt) > 0, 'still a valid timestamp');
});

// ─────────────────────────────────────────────────────────────────────────────
// Links — the only copy of a posting's URL in an alert email
// ─────────────────────────────────────────────────────────────────────────────

test('anchors are extracted in order and deduped by href', () => {
  // The real shape: a logo, the title, and a "view job" button all pointing at one posting.
  const html = `
    <a href="https://in.linkedin.com/comm/jobs/view/111?trk=logo"><img src="x.png"></a>
    <a href="https://in.linkedin.com/comm/jobs/view/111?trk=title">SDE Intern at Zomato</a>
    <a href='https://in.linkedin.com/comm/jobs/view/222'>Backend Intern</a>
    <a href="mailto:someone@example.com">email us</a>
    <a href="#footer">skip</a>`;

  const links = extractLinks(html);
  assert.deepEqual(
    links.map((l) => l.href),
    [
      'https://in.linkedin.com/comm/jobs/view/111?trk=logo',
      'https://in.linkedin.com/comm/jobs/view/111?trk=title',
      'https://in.linkedin.com/comm/jobs/view/222',
    ],
    'mailto: and in-page anchors are dropped; single quotes are handled',
  );
  assert.equal(links[1]?.text, 'SDE Intern at Zomato');
  assert.equal(links[0]?.text, '', 'an image link has no text, and that is fine');
});

test('entity-escaped hrefs and multi-line anchors survive', () => {
  // `&amp;` inside an href is normal in bulk mail, and the anchor text is often wrapped
  // across lines with nested tags.
  const html =
    '<a href="https://www.naukri.com/job-listings-sde-intern?src=alert&amp;uuid=9">\n' +
    '  <span>SDE Intern</span>\n  <b>Bengaluru</b>\n</a>';

  const [link] = extractLinks(html);
  assert.equal(link?.href, 'https://www.naukri.com/job-listings-sde-intern?src=alert&uuid=9');
  assert.match(link?.text ?? '', /SDE Intern/);
  assert.equal(link?.text.includes('<'), false, 'nested tags are stripped from the text');
});

test('the search window is expressed in whole seconds, as Gmail requires', () => {
  assert.equal(afterClause(new Date('2026-08-01T00:00:00.000Z')), 'after:1785542400');
  // Gmail rejects a fractional timestamp outright.
  assert.equal(/\./.test(afterClause(new Date(1785542400123))), false);
});
