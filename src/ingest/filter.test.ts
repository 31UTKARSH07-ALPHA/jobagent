import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEarlyCareerTechRole, matchesGeography } from './filter.ts';
import { htmlToText, decodeEntities } from './html.ts';

test('keeps early-career technical roles', () => {
  for (const title of [
    'Software Engineering Intern',
    'Machine Learning Intern (Summer 2026)',
    'Graduate Software Engineer',
    'SDE-1, Backend',
    'Junior Data Engineer',
    'Associate Engineer - Platform',
    'New Grad Software Engineer',
    'Trainee Developer',
  ]) {
    assert.ok(isEarlyCareerTechRole(title), `should keep: ${title}`);
  }
});

test('drops senior and non-technical roles', () => {
  for (const title of [
    'Senior Software Engineer',
    'Staff ML Engineer',
    'Engineering Manager',
    'SDE-2, Payments',
    'Marketing Intern', // early career, not technical
    'HR Trainee',
    'Principal Architect',
    'Software Engineer', // no early-career signal at all
  ]) {
    assert.ok(!isEarlyCareerTechRole(title), `should drop: ${title}`);
  }
});

test('a senior signal beats an early-career one', () => {
  // "Senior Engineer, University Recruiting" is a real posting and is not for a student
  assert.equal(isEarlyCareerTechRole('Senior Engineer, Graduate Programs'), false);
});

test('geography keeps India, remote, and unknown', () => {
  assert.ok(matchesGeography('Bengaluru, India'));
  assert.ok(matchesGeography('Gurugram'));
  assert.ok(matchesGeography('Remote'));
  assert.ok(matchesGeography('Remote - Anywhere'));
  assert.ok(matchesGeography(''), 'unknown location is kept for the scorer to judge');
  assert.ok(matchesGeography('Somewhereville'), 'unrecognised is kept, not dropped');
  assert.ok(matchesGeography('Home based - Worldwide'));
  assert.ok(matchesGeography('Remote, India'));
});

test('geography drops clearly-elsewhere onsite roles', () => {
  assert.equal(matchesGeography('San Francisco, CA'), false);
  assert.equal(matchesGeography('London, United Kingdom'), false);
  assert.equal(matchesGeography('Berlin, Germany'), false);
});

test('a named foreign location beats the word "remote"', () => {
  // Boards mark US-only roles remote constantly; that is not remote from India.
  assert.equal(matchesGeography('Remote - European Union'), false);
  assert.equal(matchesGeography('New York, NY (HQ), San Francisco, CA'), false);
  assert.equal(matchesGeography('Home Based - Americas'), false);
});

test('non-engineering roles that borrow tech words are dropped', () => {
  for (const title of [
    'AI Innovation Intern – Service Sales',
    'Ubuntu Sales Engineer (Entry-Level)',
    'U.S. Public Policy and AI Innovation Intern',
    'Developer Advocate Intern',
    'Technical Recruiting Intern',
  ]) {
    assert.equal(isEarlyCareerTechRole(title), false, `should drop: ${title}`);
  }
});

test('html: entities decode, including numeric and hex', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&#39;quoted&#39;'), "'quoted'");
  assert.equal(decodeEntities('&#x2019;'), '’');
});

test('html: block tags become line breaks, lists become bullets', () => {
  assert.equal(htmlToText('<p>One</p><p>Two</p>'), 'One\nTwo');
  assert.equal(htmlToText('<ul><li>A</li><li>B</li></ul>'), '• A\n• B');
  assert.equal(htmlToText('a<br>b'), 'a\nb');
});

test('html: script and style content is removed', () => {
  assert.equal(htmlToText('<p>Hi</p><script>alert(1)</script>'), 'Hi');
});

test('html: empty input stays empty', () => {
  assert.equal(htmlToText(''), '');
});
