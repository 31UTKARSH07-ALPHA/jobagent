/**
 * The plist is generated, never hand-written, so these tests cover the things that make a
 * launchd job fail at 06:00 in ways nothing reports: a relative path, a missing cwd, a
 * node binary that a Homebrew upgrade moved, or a plist that is not valid XML at all.
 *
 * Nothing here touches ~/Library/LaunchAgents or runs `launchctl`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAILY, HOURLY, ROOT, buildPlist, plistPath, resolveNode } from './launchd.ts';

const PLIST = buildPlist(DAILY, { root: '/Users/x/jobagent', node: '/opt/homebrew/bin/node', home: '/Users/x' });

test('the plist parses as a property list', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'launchd-')), 'test.plist');
  writeFileSync(file, PLIST);
  // plutil is the only judge that matters — launchd rejects the whole file on one bad tag.
  execFileSync('plutil', ['-lint', file], { stdio: 'pipe' });

  const parsed = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
  assert.equal(parsed.Label, DAILY.label);
  assert.deepEqual(parsed.StartCalendarInterval, { Hour: 6, Minute: 0 });
  assert.equal(parsed.RunAtLoad, false);
  assert.equal(parsed.WorkingDirectory, '/Users/x/jobagent');
});

test('every path in it is absolute — launchd runs with cwd /', () => {
  const parsed = plistFrom(PLIST);
  const paths = [
    parsed.WorkingDirectory,
    parsed.StandardErrorPath,
    ...parsed.ProgramArguments,
    parsed.EnvironmentVariables.JOBAGENT_NODE,
    parsed.EnvironmentVariables.HOME,
  ];
  for (const p of paths) assert.ok(p.startsWith('/'), `not absolute: ${p}`);
});

test('it runs the wrapper, not node directly', () => {
  // The wrapper is what gives every run a timestamp, a rotated log and a reproducible
  // by-hand equivalent. Calling node straight from the plist loses all three.
  const parsed = plistFrom(PLIST);
  assert.deepEqual(parsed.ProgramArguments, ['/bin/sh', '/Users/x/jobagent/scripts/run-daily.sh']);
});

test('stdout goes nowhere and stderr is kept', () => {
  // run-daily.sh tees into logs/daily.log; duplicating it here would double every line.
  const parsed = plistFrom(PLIST);
  assert.equal(parsed.StandardOutPath, '/dev/null');
  assert.equal(parsed.StandardErrorPath, '/Users/x/jobagent/logs/launchd.err');
});

test('--at rewrites only the calendar entry', () => {
  const parsed = plistFrom(buildPlist({ ...DAILY, hour: 21, minute: 5 }, { root: '/r', node: '/n', home: '/h' }));
  assert.deepEqual(parsed.StartCalendarInterval, { Hour: 21, Minute: 5 });
  assert.equal(parsed.Label, DAILY.label);
});

test('XML-hostile paths are escaped, not embedded raw', () => {
  const xml = buildPlist(DAILY, { root: '/Users/a&b/<jobs>', node: '/n', home: '/h' });
  assert.ok(!/<string>\/Users\/a&b/.test(xml));
  assert.equal(plistFrom(xml).WorkingDirectory, '/Users/a&b/<jobs>');
});

test('resolveNode prefers a stable symlink over the version-pinned real path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-'));
  // Stands in for /opt/homebrew/Cellar/node/25.2.1/bin/node — the path that disappears.
  const versioned = join(dir, 'node-25.2.1');
  writeFileSync(versioned, '');
  const stable = join(dir, 'stable-node');
  symlinkSync(versioned, stable);

  // Same binary reached two ways: the symlink wins, because Homebrew moves the other one.
  assert.deepEqual(resolveNode(versioned, [stable]), { path: stable, stable: true });
  // Nothing points at it: fall back, and say so, rather than inventing a path.
  assert.deepEqual(resolveNode(versioned, ['/nope/node']), { path: versioned, stable: false });
});

test('ROOT is the repo, and the wrapper it names exists', () => {
  assert.equal(ROOT.endsWith('/jobagent'), true);
  assert.equal(plistPath('com.example.x').endsWith('/Library/LaunchAgents/com.example.x.plist'), true);
});

function plistFrom(xml: string): any {
  const file = join(mkdtempSync(join(tmpdir(), 'launchd-')), 'test.plist');
  writeFileSync(file, xml);
  return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
}

test('the hourly agent polls on an interval, not a calendar', () => {
  // A missed hourly poll costs an hour of freshness and nothing else, so there is nothing
  // to catch up on at wake — the opposite of the daily run, which must not be skipped.
  const plist = buildPlist(HOURLY);

  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
  assert.ok(!plist.includes('StartCalendarInterval'));
});

test('the hourly agent runs the fast lane and its own log', () => {
  const plist = buildPlist(HOURLY);

  assert.match(plist, /<string>--fast<\/string>/);
  // Twenty-four "nothing new" runs a day in daily.log would bury the entry anybody reads.
  assert.match(plist, /<key>JOBAGENT_LOG<\/key>\s*<string>hourly<\/string>/);
});

test('the two agents cannot collide in launchd', () => {
  assert.notEqual(DAILY.label, HOURLY.label);
  assert.notEqual(plistPath(DAILY.label), plistPath(HOURLY.label));
});

test('the daily agent is unchanged by the hourly one existing', () => {
  const plist = buildPlist(DAILY);
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  // Matched as a key, not as text: the daily plist's own comment says the words
  // "not StartInterval", and a substring check reads that as the setting being present.
  assert.ok(!/<key>StartInterval<\/key>/.test(plist));
  assert.ok(!plist.includes('--fast'));
});
