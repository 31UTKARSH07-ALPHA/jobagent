import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchYear, fitOf, judgeRole, levelOf, parseSalary, reachOf } from './fit.ts';

test('where a role can be done from, for someone in Bengaluru', () => {
  // Real YC location strings, 2026-10-05.
  assert.equal(reachOf('Bengaluru, KA, IN / Bengaluru, Karnataka, IN'), 'bengaluru');
  assert.equal(reachOf('Bangalore / Remote (US)'), 'bengaluru');
  assert.equal(reachOf('IN / Remote (IN)'), 'india');
  assert.equal(reachOf('Hyderabad, TS, IN'), 'india');
  assert.equal(reachOf('Remote'), 'remote');
  assert.equal(reachOf('San Francisco, CA, US / Remote'), 'remote');
  assert.equal(reachOf('Remote (Worldwide)'), 'remote');
  assert.equal(reachOf('US / Remote (US)'), 'no');
  assert.equal(reachOf('San Francisco, CA, US / San Mateo, CA, US / Remote (US; CA)'), 'no');
  assert.equal(reachOf('London, England, GB'), 'no');
  // Indiana is not India.
  assert.equal(reachOf('Indianapolis, IN, US'), 'no');
  assert.equal(reachOf(''), 'no');
});

test('a student can take an internship or a new-grads-ok role, never a senior one', () => {
  const role = (title: string, min_experience = '', job_type = 'Full-time') => ({ title, min_experience, job_type });
  assert.equal(levelOf(role('Software Engineering Intern')), 'intern');
  assert.equal(levelOf(role('Backend Engineer', 'Any (new grads ok)')), 'new_grad');
  assert.equal(levelOf(role('Founding Engineer', 'Any (new grads ok)')), 'new_grad');
  assert.equal(levelOf(role('Staff Software Engineer', 'Any (new grads ok)')), null);
  assert.equal(levelOf(role('Senior Software Engineer', '3+ years')), null);
  assert.equal(levelOf(role('Software Engineer', '1+ years')), null);
});

test('a role has to be software, open, and reachable', () => {
  const base = { location: 'Remote', job_type: 'Full-time', min_experience: 'Any (new grads ok)' };
  assert.notEqual(judgeRole({ ...base, title: 'Software Engineer', role: 'eng' }), null);
  // Both reached the first live shortlist.
  assert.equal(judgeRole({ ...base, title: 'Data Collection Specialist', role: 'eng' }), null);
  assert.equal(judgeRole({ ...base, title: '[PAUSED] Growth Engineer (Contract)', role: 'eng' }), null);
  assert.equal(judgeRole({ ...base, title: 'SEO Associate', role: 'marketing' }), null);
  assert.equal(judgeRole({ ...base, title: 'Software Engineer', location: 'Remote (US)' }), null);
  // A remote role abroad that needs a US visa is not one he can take...
  assert.equal(judgeRole({ ...base, title: 'Software Engineer', visa: 'US citizen/visa only' }), null);
  assert.notEqual(judgeRole({ ...base, title: 'Software Engineer', visa: 'US citizenship/visa not required' }), null);
  // ...but YC prints that on Bengaluru roles too, where it means nothing.
  assert.notEqual(
    judgeRole({ ...base, title: 'Software Engineer', location: 'Bengaluru, KA, IN', visa: 'US citizen/visa only' }),
    null,
  );
});

test('pay is read in lakh a year, including monthly stipends and hourly contracts', () => {
  assert.equal(parseSalary('₹800K - ₹2M INR'), 20);
  assert.equal(parseSalary('₹25K - ₹75K INR / monthly'), 9);
  assert.equal(parseSalary('$4K - $8K / monthly'), 81.6);
  assert.equal(parseSalary('$15 - $25 / hourly'), 42.5);
  // YC writes thousands without the K often enough to read it that way.
  assert.equal(parseSalary('$130 - $190'), 161.5);
  // Placeholders on real listings.
  assert.equal(parseSalary('$1'), null);
  assert.equal(parseSalary('₹40 INR'), null);
  assert.equal(parseSalary(''), null);
});

test('batch year from either spelling', () => {
  assert.equal(batchYear('Winter 2024'), 2024);
  assert.equal(batchYear('W21'), 2021);
  assert.equal(batchYear(''), 0);
});

const startup = {
  location: 'Bengaluru, KA, India',
  batch: `Winter ${new Date().getFullYear()}`,
  team_size: 3,
  one_liner: 'Train, eval and build autonomous agents',
  tags: ['B2B'],
};

test('a listed internship outranks an open application, and an open application is India-only', () => {
  const intern = fitOf({
    ...startup,
    roles: [
      { title: 'Software Engineering Intern', location: 'Bengaluru, KA, IN', job_type: 'Internship', min_experience: '', salary: '₹25K - ₹75K INR / monthly' },
    ],
  });
  const open = fitOf({ ...startup, roles: [{ title: 'Senior Engineer', location: 'Bengaluru', job_type: 'Full-time', min_experience: '5+ years', salary: '' }] });
  assert.ok(intern !== null && open !== null);
  assert.ok(intern.rank > open.rank, `${intern.rank} should beat ${open.rank}`);
  assert.equal(open.best, null);
  assert.match(intern.why, /internship listed · bengaluru/);

  // Remote abroad with nothing junior listed is the company least likely to answer.
  assert.equal(fitOf({ ...startup, location: 'San Francisco, CA', roles: [] }), null);
});
