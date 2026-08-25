/**
 * The generation itself is a network call. What is tested here is the checker that decides
 * whether what came back is fit to send — the last thing between a model and a stranger's
 * inbox.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDraft, problemsWith, type DraftResult } from './compose.ts';
import type { Profile } from '../store/schema.ts';

const profile = {
  name: 'Utkarsh Pathak',
  email: 'u@example.com',
  phone: '',
  links: [],
  education: [
    {
      institution: 'Scaler School of Technology',
      degree: 'Undergraduate Program in Computer Science',
      dates: '2024 – Present',
      location: 'Bengaluru',
      score: '',
    },
  ],
  summary: 'Builds retrieval and backend systems.',
  skills: [{ category: 'Languages', items: ['TypeScript', 'Java'] }],
  domains: ['retrieval-augmented generation'],
  projects: [],
  experience: [],
  achievements: [],
  target_roles: ['Backend Engineer'],
  extracted_at: new Date().toISOString(),
  model: 'test',
} satisfies Profile;

const draft = (over: Partial<DraftResult> = {}): DraftResult => ({
  subject: 'Backend Intern – 8 ms typeahead latency',
  body: [
    'Hi Acme team,',
    '',
    'I built a distributed typeahead system that reached a p95 latency of 8 ms on the',
    'suggest endpoint, using nginx, Kafka and a Redis Cluster with a hand-rolled',
    'consistent-hash ring. That work lines up with the read-heavy services your backend',
    'internship describes, and I would like to help build them.',
    '',
    'Could we schedule a short call to discuss whether you are taking applications?',
    '',
    'Utkarsh Pathak',
  ].join('\n'),
  ...over,
});

test('a well-formed reply parses into subject and body', () => {
  const parsed = parseDraft('Subject: Backend Intern – 8 ms latency\n\nHi there,\n\nBody text.\n\nUtkarsh');
  assert.equal(parsed.subject, 'Backend Intern – 8 ms latency');
  assert.equal(parsed.body, 'Hi there,\n\nBody text.\n\nUtkarsh');
});

test('a reply with no subject line is refused rather than guessed at', () => {
  // Sending with a mangled subject is worse than waiting for tomorrow's run.
  assert.throws(() => parseDraft('Hi there, here is my email.'), /Subject/);
  assert.throws(() => parseDraft('Subject:   \n\n'), /empty/);
});

test('a good draft has nothing wrong with it', () => {
  assert.deepEqual(problemsWith(draft(), profile, 'Acme'), []);
});

test('placeholders are caught', () => {
  // A model that writes "[Your Name]" has returned perfectly valid text and an unusable email.
  for (const body of ['Dear [Hiring Manager], I am keen.', 'Regards, {{name}}', 'Hi <COMPANY>, hello.']) {
    assert.ok(problemsWith(draft({ body }), profile, 'Acme').some((p) => /placeholder|short/.test(p)), body);
  }
});

test('an unsigned email is caught', () => {
  const unsigned = draft().body.replace('Utkarsh Pathak', 'Best regards');
  assert.ok(problemsWith(draft({ body: unsigned }), profile, 'Acme').includes('the candidate never signs their name'));
});

test('an email that never names the company is caught', () => {
  const anonymous = draft().body.replace('Hi Acme team,', 'Hi there,');
  assert.ok(problemsWith(draft({ body: anonymous }), profile, 'Acme').includes('the company is never named'));
});

test('punctuation in the company name does not fail a good draft', () => {
  // "Azuga, Inc." was searched for literally as `azuga,` — comma included — so a draft that
  // named Azuga three times was rejected twice and thrown away.
  const body = draft().body.replace('Hi Acme team,', 'Hi Azuga team,');
  assert.deepEqual(problemsWith(draft({ body }), profile, 'Azuga, Inc.'), []);
  assert.deepEqual(problemsWith(draft({ body }), profile, 'Azuga Technologies Pvt Ltd'), []);
});

test('invented work experience is caught', () => {
  // The resume lists no employment, so any claim of it is a fabrication — and it is the one
  // mistake in a first cold email that cannot be walked back.
  const lying = draft().body.replace('I built', 'In my three years of professional experience I built');
  assert.ok(
    problemsWith(draft({ body: lying }), profile, 'Acme').includes('claims work experience the resume does not have'),
  );
});

test('an invented year of study is caught', () => {
  // Measured on the first real draft: the model wrote "As a final-year computer science
  // student", which the resume never says. It came from the scorer's reasoning.
  const guessing = draft().body.replace('I built', 'As a final-year student I built');
  assert.ok(
    problemsWith(draft({ body: guessing }), profile, 'Acme').includes(
      'states a year of study or graduation the resume never claims',
    ),
  );
});

test('a resume that does state the year is allowed to say so', () => {
  const finalYear = { ...profile, summary: 'A final-year computer science student.' };
  const body = draft().body.replace('I built', 'As a final-year student I built');
  assert.deepEqual(problemsWith(draft({ body }), finalYear, 'Acme'), []);
});

test('length is bounded at both ends', () => {
  assert.ok(problemsWith(draft({ body: 'Hi Acme. Utkarsh Pathak' }), profile, 'Acme').some((p) => /too short/.test(p)));
  const rambling = `Hi Acme team, ${'words '.repeat(250)} Utkarsh Pathak`;
  assert.ok(problemsWith(draft({ body: rambling }), profile, 'Acme').some((p) => /too long/.test(p)));
});

test('an over-long subject is caught', () => {
  const long = `Backend Intern application from a candidate with ${'x'.repeat(60)}`;
  assert.ok(problemsWith(draft({ subject: long }), profile, 'Acme').some((p) => /subject is/.test(p)));
});
