#!/usr/bin/env node
// Runs Vitest for one project and prints a compact JSON result.
// Usage: node run-tests.mjs <backend|frontend> [test files relative to repo root...]
//   with files   -> runs only those files, no coverage (fast feedback loop)
//   without files -> runs the whole suite with coverage and configured thresholds
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const [project, ...files] = process.argv.slice(2);
const testPattern = { backend: /^backend\/tests\/.+\.test\.ts$/, frontend: /^frontend\/src\/.+\.test\.tsx?$/ }[project];
if (!testPattern) fail(`Unknown project "${project}". Use backend or frontend.`);
const projectDir = path.join(root, project);
const vitest = path.join(projectDir, 'node_modules/vitest/vitest.mjs');
if (!existsSync(vitest)) fail(`Dependencies missing: run "npm ci" in ${project}/ first.`);

const relative = files.map((file) => {
  const normalized = file.replaceAll('\\', '/');
  if (!testPattern.test(normalized) || normalized.includes('..')) fail(`Not a ${project} test file: ${file}`);
  return path.posix.relative(project, normalized);
});

const tmp = mkdtempSync(path.join(tmpdir(), 'vitest-'));
const report = path.join(tmp, 'report.json');
const args = [vitest, 'run', '--reporter=json', `--outputFile=${report}`, ...relative];
const coverage = relative.length === 0;
if (coverage) args.push('--coverage', '--coverage.reporter=json-summary', '--coverage.reporter=text');

const run = spawnSync(process.execPath, args, { cwd: projectDir, encoding: 'utf8', timeout: 300_000, env: { ...process.env, CI: 'true' } });
const json = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null;
rmSync(tmp, { recursive: true, force: true });

const result = {
  project,
  scope: coverage ? 'full-suite' : relative,
  ok: run.status === 0,
  exitCode: run.status,
  tests: json && { total: json.numTotalTests, passed: json.numPassedTests, failed: json.numFailedTests },
  failures: (json?.testResults ?? []).flatMap((suite) => {
    const file = path.posix.relative(projectDir.replaceAll('\\', '/'), suite.name.replaceAll('\\', '/'));
    const failed = suite.assertionResults.filter((a) => a.status === 'failed')
      .map((a) => ({ file, test: a.fullName, message: trim(a.failureMessages.join('\n')) }));
    // A suite can fail without failed assertions (syntax error, bad import).
    return failed.length || suite.status !== 'failed' ? failed : [{ file, test: '(suite)', message: trim(suite.message) }];
  }),
};
if (coverage) {
  const summary = path.join(projectDir, 'coverage/coverage-summary.json');
  if (existsSync(summary)) {
    const { total, ...perFile } = JSON.parse(readFileSync(summary, 'utf8'));
    result.coverage = Object.fromEntries(['statements', 'branches', 'functions', 'lines'].map((k) => [k, total[k].pct]));
    // Least-covered files first: the work list for "improve coverage" tasks.
    result.uncovered = Object.entries(perFile)
      .map(([file, c]) => ({ file: path.relative(root, file).replaceAll('\\', '/'), lines: c.lines.pct, branches: c.branches.pct }))
      .filter((f) => f.lines < 100 || f.branches < 100)
      .sort((a, b) => a.lines - b.lines || a.branches - b.branches);
  }
}
// Non-zero exit without failed tests = threshold breach, timeout or crash: surface the log tail.
if (!result.ok && !result.failures.length) result.log = trim(`${run.stdout}\n${run.stderr}`.trim().split('\n').slice(-40).join('\n'));

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

function trim(text = '') {
  // Drop framework stack frames; they cost tokens and never help fix a test.
  text = text.split('\n').filter((line) => !line.includes('node_modules') && !line.includes('(<anonymous>)')).join('\n');
  return text.length > 2000 ? `${text.slice(0, 2000)}\n…(truncated)` : text;
}
function fail(message) {
  console.error(message);
  process.exit(2);
}
