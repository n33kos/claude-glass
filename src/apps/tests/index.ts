import { type AppDef, type Args, capTail, unknownCommand } from '../types';

// Test runs Claude does, as results: spotted in Bash commands (npm test, vitest, jest, pytest, go
// test, cargo test, ...) and read from the runner's own summary. Best effort by design: a run whose
// output has no summary we recognize still shows, as passed or failed by its exit.
export interface TestRun {
  at: number;
  command: string;
  runner: string;
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
  failures: string[]; // names of failing tests, as the runner printed them
  durationMs?: number;
}
export interface TestsState { runs: TestRun[] }

const RUNNERS: [string, RegExp][] = [
  ['vitest', /\bvitest\b/], ['jest', /\bjest\b/], ['pytest', /\bpytest\b|python\d? -m pytest/], ['go', /\bgo test\b/],
  ['cargo', /\bcargo (nextest|test)\b/], ['rspec', /\brspec\b/], ['mocha', /\bmocha\b/], ['playwright', /\bplaywright test\b/],
  ['dotnet', /\bdotnet test\b/], ['mix', /\bmix test\b/], ['phpunit', /\bphpunit\b/], ['gradle', /\bgradle\w* test\b/], ['maven', /\bmvn\b.*\btest\b/],
  ['npm', /\b(npm|pnpm|yarn|bun)( run)? test\b/], ['bun', /\bbun test\b/], ['make', /\bmake (test|check)\b/],
];

export function detectRunner(command: string): string | null {
  for (const [name, re] of RUNNERS) if (re.test(command)) return name;
  return null;
}

const num = (m: RegExpMatchArray | null) => (m ? Number(m[1]) : 0);
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Counts and failing test names from a runner's output (the summary lines most runners print). */
export function parseResults(raw: string): { passed: number; failed: number; skipped: number; failures: string[]; found: boolean } {
  const out = raw.replace(ANSI, '');
  let passed = 0, failed = 0, skipped = 0, found = false;
  // vitest "Tests  1 failed | 67 passed (68)", jest "Tests:  1 failed, 26 passed, 27 total",
  // pytest "== 3 failed, 10 passed, 1 skipped in 1.2s ==", mocha "10 passing / 2 failing",
  // cargo "test result: ok. 10 passed; 0 failed; 1 ignored", rspec "12 examples, 1 failure".
  const summary = out.match(/^\s*Tests:?\s+\d.*$/m)?.[0] ?? out.match(/^=+ .*(passed|failed).* =+$/m)?.[0] ?? out.match(/test result: .*$/m)?.[0] ?? null;
  if (summary) {
    passed = num(summary.match(/(\d+) pass(?:ed|ing)?/)); failed = num(summary.match(/(\d+) fail(?:ed|ing|ures?)?/));
    skipped = num(summary.match(/(\d+) (?:skipped|ignored|todo|pending)/)); found = passed + failed + skipped > 0;
  }
  if (!found) {
    const pass = out.match(/(\d+) (?:passing|passed)/), fail = out.match(/(\d+) (?:failing|failed|failures?)\b/);
    const rs = out.match(/(\d+) examples?, (\d+) failures?/);
    if (rs) { failed = Number(rs[2]); passed = Number(rs[1]) - failed; found = true; }
    else if (pass || fail) { passed = num(pass); failed = num(fail); found = true; }
  }
  // Go: one "ok"/"FAIL" line per package, "--- FAIL: TestName" per test.
  if (!found && /^(ok|FAIL)\s+\S+/m.test(out)) {
    passed = (out.match(/^--- PASS/gm) ?? []).length || (out.match(/^ok\s+\S+/gm) ?? []).length;
    failed = (out.match(/^--- FAIL/gm) ?? []).length || (out.match(/^FAIL\s+\S+/gm) ?? []).length;
    found = true;
  }
  const failures = [...new Set([
    ...[...out.matchAll(/^[ \t]*(?:FAIL|×|✗|✕) +(.+?)\s*(?:\d+ms)?$/gm)].map((m) => m[1]), // not Go's "FAIL\t<package>"
    ...[...out.matchAll(/^FAILED\s+(\S+)/gm)].map((m) => m[1]),
    ...[...out.matchAll(/^--- FAIL: (\S+)/gm)].map((m) => m[1]),
    ...[...out.matchAll(/^\s*●\s+(.+)$/gm)].map((m) => m[1]),
  ].map((f) => f.trim()).filter((f) => f && !/^\d+ /.test(f)))].slice(0, 30);
  return { passed, failed, skipped, failures, found };
}

export const tests: AppDef<TestsState> = {
  type: 'tests',
  title: 'Tests',
  icon: '✓',
  singleton: true,
  autoOpen: true,
  description: 'Results of the test runs Claude does (npm test, vitest, jest, pytest, go test, cargo test...). Fills itself.',
  commands: {
    clear: { usage: 'clear', help: 'Forget past runs' },
  },
  init: () => ({ runs: [] }),
  command(s, cmd, _a: Args) {
    if (cmd === 'clear') return tests.init();
    return unknownCommand('tests', cmd);
  },
  onHook(s, p) {
    const ev = p?.hook_event_name;
    if ((ev !== 'PostToolUse' && ev !== 'PostToolUseFailure') || p.tool_name !== 'Bash') return s;
    const command = String(p.tool_input?.command ?? '');
    const runner = detectRunner(command);
    if (!runner) return s;
    const r = p.tool_response ?? {};
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}\n${ev === 'PostToolUseFailure' ? p.error ?? '' : ''}`;
    const res = parseResults(output);
    // Nothing recognizable and no failure signal: probably not a real run (e.g. `npm test --help`).
    if (!res.found && ev !== 'PostToolUseFailure' && !r.interrupted && !/fail|error/i.test(output)) return s;
    const ok = res.found ? res.failed === 0 : ev !== 'PostToolUseFailure' && !/\bfail/i.test(output);
    const run: TestRun = { at: Date.now(), command: command.slice(0, 300), runner, passed: res.passed, failed: res.failed, skipped: res.skipped, ok, failures: res.failures, durationMs: p.duration_ms };
    return { runs: capTail([...s.runs, run], 30) };
  },
};

export default tests;
