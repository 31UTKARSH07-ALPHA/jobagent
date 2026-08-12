/**
 * The 06:00 schedule: generates, installs and removes the launchd agent that runs
 * `scripts/run-daily.sh`.
 *
 *   node src/schedule/launchd.ts --print      # the plist, to stdout, touching nothing
 *   node src/schedule/launchd.ts --install    # write it, load it, confirm it
 *   node src/schedule/launchd.ts --status     # is it loaded, when does it next run
 *   node src/schedule/launchd.ts --uninstall  # unload and delete
 *   node src/schedule/launchd.ts --kickstart  # fire a real run right now (sends the digest)
 *
 * Why a generator instead of a checked-in plist: every value in it is absolute and
 * machine-specific — the project path, the node binary, $HOME. A committed plist would
 * be a file full of one laptop's paths that silently runs the wrong thing on any other.
 * Here the paths are read off the running process, and `--print` shows exactly what
 * `--install` will write.
 *
 * Read `docs/decisions.md` 018 before changing the shape of the job.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** Repo root, from this file's location — never from `cwd`, which launchd sets to `/`. */
export const ROOT = resolve(import.meta.dirname, '../..');

export type LaunchdJob = {
  label: string;
  /** Path relative to `ROOT`. Absolute in the plist. */
  script: string;
  /** Local time. launchd runs a missed calendar job on wake, which is the point. */
  hour: number;
  minute: number;
};

/**
 * The daily pipeline: ingest → score → digest (the rest are no-ops until Phase 2).
 * 06:00 rather than later because scoring is paced by Groq's token budget and takes
 * ~35 minutes for 30 jobs — the digest lands when scoring finishes, not at a fixed
 * time (decision 017).
 *
 * Phase 3's 4-hourly tracker is a second job, added here as a second object.
 */
export const DAILY: LaunchdJob = {
  label: 'com.utkarsh.jobagent.daily',
  script: 'scripts/run-daily.sh',
  hour: 6,
  minute: 0,
};

export function plistPath(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * `process.execPath` is `/opt/homebrew/Cellar/node/25.2.1/bin/node` — a version-pinned
 * path that stops existing the next time Homebrew upgrades node, taking the schedule
 * with it silently. Prefer a stable symlink that resolves to the *same* binary, so the
 * plist survives upgrades.
 */
export function resolveNode(
  execPath: string = process.execPath,
  candidates: string[] = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'],
): { path: string; stable: boolean } {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return { path: execPath, stable: false };
  }
  for (const c of candidates) {
    try {
      if (realpathSync(c) === real) return { path: c, stable: true };
    } catch {
      // not installed there; try the next
    }
  }
  return { path: execPath, stable: false };
}

export function buildPlist(
  job: LaunchdJob,
  opts: { root?: string; node?: string; home?: string } = {},
): string {
  const root = opts.root ?? ROOT;
  const node = opts.node ?? resolveNode().path;
  const home = opts.home ?? homedir();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(job.label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${esc(join(root, job.script))}</string>
  </array>

  <!-- node's --env-file-if-exists=.env resolves against cwd, and launchd's cwd is /. -->
  <key>WorkingDirectory</key>
  <string>${esc(root)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd has no login shell, so the node path is recorded rather than searched. -->
    <key>JOBAGENT_NODE</key>
    <string>${esc(node)}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <!-- token.json and credentials.json are read relative to WorkingDirectory, but
         Google's client still wants a HOME to exist. -->
    <key>HOME</key>
    <string>${esc(home)}</string>
  </dict>

  <!-- StartCalendarInterval, not StartInterval: a shut or sleeping laptop runs the
       missed job on wake instead of drifting a little further every day. -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${job.hour}</integer>
    <key>Minute</key>
    <integer>${job.minute}</integer>
  </dict>

  <!-- False on purpose: loading the agent, or logging in, must not fire a pipeline
       run and a Telegram digest. -->
  <key>RunAtLoad</key>
  <false/>

  <!-- run-daily.sh owns the real log (logs/daily.log) and tees to stdout, so stdout
       here would be a duplicate. This file catches only launchd-level failures —
       a missing or non-executable wrapper. -->
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(root, 'logs', 'launchd.err'))}</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('launchctl', args, { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`.trim() };
  }
}

function isLoaded(label: string): boolean {
  return launchctl(['print', `${domain()}/${label}`]).ok;
}

function install(job: LaunchdJob): number {
  const script = join(ROOT, job.script);
  if (!existsSync(script)) {
    console.error(`missing ${script} — nothing to schedule`);
    return 1;
  }
  // A wrapper without +x fails at exec time, hours later, into a log nobody is watching.
  if ((statSync(script).mode & 0o111) === 0) {
    console.error(`${script} is not executable — chmod +x it first`);
    return 1;
  }

  const node = resolveNode();
  if (!node.stable) {
    console.warn(
      `warning: no stable symlink for ${node.path}; a node upgrade will need --install again`,
    );
  }

  const path = plistPath(job.label);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  writeFileSync(path, buildPlist(job, { node: node.path }), { mode: 0o644 });
  console.log(`wrote ${path}`);

  // bootstrap fails outright if the label is already loaded, so unload first. This is
  // what makes --install idempotent and re-runnable after an edit.
  if (isLoaded(job.label)) launchctl(['bootout', `${domain()}/${job.label}`]);

  const boot = launchctl(['bootstrap', domain(), path]);
  if (!boot.ok) {
    console.error(`launchctl bootstrap failed: ${boot.out}`);
    return 1;
  }

  console.log(
    [
      `loaded ${job.label} — next run ${String(job.hour).padStart(2, '0')}:${String(job.minute).padStart(2, '0')} local`,
      `  node   ${node.path}`,
      `  runs   ${script}`,
      `  log    ${join(ROOT, 'logs', 'daily.log')}`,
      '',
      'macOS lists this under System Settings → General → Login Items & Extensions.',
      'If it gets switched off there, launchd will not run it.',
      '',
      'To remove it:  node src/schedule/launchd.ts --uninstall',
      `  (by hand:    launchctl bootout ${domain()}/${job.label} && rm ${path})`,
    ].join('\n'),
  );
  return 0;
}

function uninstall(job: LaunchdJob): number {
  const path = plistPath(job.label);
  const loaded = isLoaded(job.label);
  if (loaded) {
    const out = launchctl(['bootout', `${domain()}/${job.label}`]);
    console.log(out.ok ? `unloaded ${job.label}` : `bootout failed: ${out.out}`);
  } else {
    console.log(`${job.label} was not loaded`);
  }
  if (existsSync(path)) {
    unlinkSync(path);
    console.log(`removed ${path}`);
  }
  console.log('logs/ and data/ are untouched.');
  return 0;
}

function status(job: LaunchdJob): number {
  const path = plistPath(job.label);
  console.log(`plist   ${existsSync(path) ? path : `${path} (absent)`}`);

  const printed = launchctl(['print', `${domain()}/${job.label}`]);
  if (!printed.ok) {
    console.log('state   not loaded');
    console.log('\nload it with: node src/schedule/launchd.ts --install');
    return 0;
  }
  // `launchctl print` is ~100 lines of domain internals; these are the four that answer
  // "is it alive, did it work, when does it go again".
  const keep = /^\s*(state|pid|last exit code|runs|program|working directory) =/i;
  const lines = printed.out
    .split('\n')
    .filter((l) => keep.test(l))
    .map((l) => `  ${l.trim()}`);
  console.log(`state   loaded\n${lines.join('\n')}`);
  console.log(`\nlog     tail -f ${join(ROOT, 'logs', 'daily.log')}`);
  return 0;
}

function kickstart(job: LaunchdJob): number {
  if (!isLoaded(job.label)) {
    console.error(`${job.label} is not loaded — run --install first`);
    return 1;
  }
  const out = launchctl(['kickstart', '-p', `${domain()}/${job.label}`]);
  if (!out.ok) {
    console.error(`kickstart failed: ${out.out}`);
    return 1;
  }
  console.log(
    `started now (${out.out.trim()}) — this is a real run and will send a digest\n` +
      `tail -f ${join(ROOT, 'logs', 'daily.log')}`,
  );
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      install: { type: 'boolean', default: false },
      uninstall: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      print: { type: 'boolean', default: false },
      kickstart: { type: 'boolean', default: false },
      at: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  let job = DAILY;
  if (values.at !== undefined) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(values.at);
    const hour = Number(m?.[1]);
    const minute = Number(m?.[2]);
    if (!m || hour > 23 || minute > 59) {
      console.error(`--at expects HH:MM in 24h local time, got "${values.at}"`);
      return 2;
    }
    job = { ...DAILY, hour, minute };
  }

  if (values.help || !(values.install || values.uninstall || values.status || values.print || values.kickstart)) {
    console.log(
      [
        'usage: node src/schedule/launchd.ts [--install|--uninstall|--status|--print|--kickstart] [--at=HH:MM]',
        '',
        `  --install    write ~/Library/LaunchAgents/${DAILY.label}.plist and load it`,
        '  --uninstall  unload and delete it',
        '  --status     loaded? last exit code? next run?',
        '  --print      show the plist without installing anything',
        '  --kickstart  run it now through launchd — a real run, sends a real digest',
        `  --at=HH:MM   schedule time, default ${String(DAILY.hour).padStart(2, '0')}:${String(DAILY.minute).padStart(2, '0')}`,
      ].join('\n'),
    );
    return 0;
  }

  if (values.print) {
    process.stdout.write(buildPlist(job));
    return 0;
  }
  if (values.install) return install(job);
  if (values.uninstall) return uninstall(job);
  if (values.kickstart) return kickstart(job);
  return status(job);
}

if (import.meta.main) {
  process.exitCode = await main();
}
