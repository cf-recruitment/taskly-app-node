// publish job: decide the final status, render the 3 sticky PR comments and the job summary.
// Usage: node report.ts --dir <artifacts> [--post]
// Reads from <dir>: context.json (required), scope.json, verdicts.json, review.json, checked.json, results.json.
// Writes to <dir>: status.json, report.md, author.md, reviewer.md. --post also writes status + comments to GitHub.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api } from './github.ts';
import { LABEL_SKIP_PHRASE, STATUS_CONTEXT } from './rules.ts';
import type { Scope } from './prepare.ts';
import type { Checked, Review, Verdicts } from './verdicts.ts';

type Result = 'success' | 'failure' | 'cancelled' | 'skipped';
export type Context = {
  pr: number;
  analyzed_sha: string;
  final_sha: string;
  run_url: string;
  same_repo: boolean;
  label_skip: boolean;
  label_actor: string;
  run_agent: boolean;
  jobs: Record<'prepare' | 'engineer' | 'commit' | 'verify', Result>;
};
type Check = 'pass' | 'fail' | 'skipped';
type Coverage = Record<string, Record<string, { lines: number; branches: number }>>;
export type Results = {
  typecheck: Record<string, Check>;
  tests: Record<string, { status: Check; passed: number; failed: number }>;
  coverage: { baseline: Coverage; final: Coverage };
  mutation: Record<string, { score: number; survived: { file: string; line: number; mutator: string }[] } | null>;
};
export type Inputs = {
  ctx: Context;
  scope?: Scope;
  verdicts?: Verdicts;
  review?: Review;
  checked?: Checked;
  results?: Results;
};

export const MARKERS = {
  report: '<!-- pr-test-engineer:report -->',
  author: '<!-- pr-test-engineer:author -->',
  reviewer: '<!-- pr-test-engineer:reviewer -->',
};
const ZWSP = '​';

// Agent text is untrusted (the PR body can steer it): no HTML, no pings, no external links or images.
export function sanitize(text: string, repo: string, max = 3000): string {
  const own = `https://github.com/${repo}/`;
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-zA-Z!][^>]*>/g, '')
    .replace(/&#?\w+;/g, '')
    .replace(/</g, '&lt;')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^\s*\[[^\]]+\]:\s*\S.*$/gm, '')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\[([^\]]*)\]\(\s*([^)\s]*)[^)]*\)/g, (_all, label, url) => (url.startsWith(own) ? `[${label}](${url})` : label))
    .replace(/https?:\/\/[^\s)>\]]+/g, (url) => (url.startsWith(own) ? url : '[link removed]'))
    .replace(/(^|[^\w`/])@(?=\w)/g, `$1@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`);
  return cleaned.length > max ? cleaned.slice(0, max) + '\n\n(truncated)' : cleaned;
}

const cell = (text: string, repo: string) => sanitize(text, repo, 300).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const short = (sha: string) => sha.slice(0, 7);

function confirmedDefects(i: Inputs) {
  const confirmed = new Set((i.review?.defects ?? []).filter((d) => d.decision === 'confirmed').map((d) => d.unit));
  return (i.verdicts?.units ?? []).filter((u) => u.verdict === 'flagged-defect' && confirmed.has(u.unit));
}

export function decide(i: Inputs): { state: 'success' | 'failure'; description: string } {
  const { ctx } = i;
  const reasons: string[] = [];
  if (ctx.jobs.prepare !== 'success') reasons.push('prepare failed');
  if (ctx.run_agent) {
    if (ctx.jobs.engineer !== 'success') reasons.push('author or reviewer did not finish');
    else if (ctx.jobs.commit !== 'success') reasons.push('commit step failed');
    else if (!i.verdicts || !i.checked) reasons.push('agent output missing');
    else if (!i.checked.ok) reasons.push('agent output invalid or patch rejected');
  }
  if (ctx.jobs.verify !== 'success' || !i.results) reasons.push('verification did not finish');
  else {
    const failed = [
      ...Object.entries(i.results.typecheck).filter(([, v]) => v === 'fail').map(([k]) => `${k} typecheck`),
      ...Object.entries(i.results.tests).filter(([, v]) => v.status === 'fail').map(([k]) => `${k} tests`),
    ];
    if (failed.length) reasons.push(`${failed.join(', ')} failed`);
  }
  const defects = confirmedDefects(i).length;
  if (defects) reasons.push(`${defects} confirmed defect${defects > 1 ? 's' : ''}`);

  const prefix = ctx.label_skip ? `${LABEL_SKIP_PHRASE} (@${ctx.label_actor}); ` : '';
  const state = reasons.length ? 'failure' : 'success';
  const summary = reasons.length ? reasons.join('; ') : headline(i);
  return { state, description: (prefix + summary).slice(0, 140) };
}

function headline(i: Inputs): string {
  const units = i.verdicts?.units ?? [];
  const rejected = new Set(i.checked?.reviewRejected ?? []);
  const tested = units.filter((u) => (u.verdict === 'added' || u.verdict === 'amended') && !rejected.has(u.unit)).length;
  if (!i.ctx.run_agent) return 'no agent run; suites pass';
  const defects = confirmedDefects(i).length;
  return `${tested} unit${tested === 1 ? '' : 's'} tested, ${defects} confirmed defect${defects === 1 ? '' : 's'}`;
}

function header(ctx: Context): string {
  const same = ctx.analyzed_sha === ctx.final_sha ? '' : ` · final \`${short(ctx.final_sha)}\``;
  return `Analyzed \`${short(ctx.analyzed_sha)}\`${same} · [run](${ctx.run_url})`;
}

function notRun(i: Inputs, who: string, why: string): string {
  return `Not run on \`${short(i.ctx.analyzed_sha)}\`: ${why}.`.replace('Not run', `${who} not run`);
}

function whyNoAgent(i: Inputs): string {
  const { ctx } = i;
  if (ctx.label_skip) return `skipped by label (@${ctx.label_actor})`;
  if (!ctx.same_repo) return 'fork pull request';
  if (ctx.jobs.prepare !== 'success') return 'prepare failed';
  if (!i.scope?.candidates.length) return 'no testable changes';
  if (ctx.jobs.engineer !== 'success') return 'the agent step failed or timed out';
  return 'no agent output';
}

export function renderReport(i: Inputs, repo: string): string {
  const { ctx } = i;
  const status = decide(i);
  const out = [MARKERS.report, `### ${status.state === 'success' ? '🟢' : '🔴'} ${status.description}`, header(ctx), ''];

  const defects = i.verdicts?.units.filter((u) => u.verdict === 'flagged-defect') ?? [];
  if (defects.length) {
    out.push('#### Defects');
    for (const unit of defects) {
      const decision = i.review?.defects.find((d) => d.unit === unit.unit);
      const label = decision?.decision === 'confirmed' ? '🔴 confirmed' : '⚠️ rejected by reviewer (warning)';
      const d = unit.defect;
      out.push(`- ${label}: \`${cell(unit.unit, repo)}\` in \`${cell(unit.path, repo)}\``);
      if (d) out.push(`  - test: ${cell(d.test, repo)}`, `  - expected: ${cell(d.expected, repo)}`, `  - received: ${cell(d.received, repo)}`, `  - source: ${cell(d.source, repo)}`);
      if (decision) out.push(`  - reviewer quote: ${cell(decision.source_quote, repo)}`);
    }
    out.push('');
  }

  if (i.scope?.skipped.length) {
    out.push('<details><summary>Skipped files</summary>', '', ...i.scope.skipped.map((s) => `- \`${s.path}\` · ${s.reason}`), '', '</details>', '');
  }

  const r = i.results;
  out.push('#### Test results');
  if (!r) out.push('No results (verification did not finish).');
  else {
    out.push('| Check | Result |', '|---|---|');
    for (const [pkg, v] of Object.entries(r.typecheck)) out.push(`| ${pkg} typecheck | ${v} |`);
    for (const [pkg, v] of Object.entries(r.tests)) out.push(`| ${pkg} tests | ${v.status} (${v.passed} passed, ${v.failed} failed) |`);
  }
  out.push('');

  out.push('#### Coverage of changed files');
  const rows = (i.scope?.candidates ?? []).map((c) => {
    const key = c.path.slice(c.package.length + 1);
    const before = r?.coverage.baseline[c.package]?.[key];
    const after = r?.coverage.final[c.package]?.[key];
    const fmt = (b?: number, a?: number) => (b === undefined && a === undefined ? 'n/a' : `${b ?? 'n/a'} → ${a ?? 'n/a'}`);
    return `| \`${c.path}\` | ${fmt(before?.lines, after?.lines)} | ${fmt(before?.branches, after?.branches)} |`;
  });
  out.push(...(rows.length ? ['| File | Lines % | Branches % |', '|---|---|---|', ...rows] : ['No changed source files.']), '');

  out.push('<details><summary>Mutation (information only)</summary>', '');
  const mutation = Object.entries(r?.mutation ?? {});
  if (!mutation.length) out.push('Not run.');
  for (const [pkg, m] of mutation) {
    if (!m) { out.push(`- ${pkg}: not run`); continue; }
    out.push(`- ${pkg}: score ${m.score}%`);
    for (const s of m.survived.slice(0, 20)) out.push(`  - survived: \`${s.file}:${s.line}\` ${cell(s.mutator, repo)}`);
    if (m.survived.length > 20) out.push(`  - … ${m.survived.length - 20} more`);
  }
  out.push('', '</details>');
  return out.join('\n');
}

export function renderAuthor(i: Inputs, repo: string): string {
  const out = [MARKERS.author, '### Test author', header(i.ctx), ''];
  if (!i.verdicts) return [...out, notRun(i, 'Author', whyNoAgent(i))].join('\n');
  const rejected = new Set(i.checked?.reviewRejected ?? []);
  out.push(sanitize(i.verdicts.summary, repo), '', '| Unit | Verdict | Kind | Tests | Attempts |', '|---|---|---|---|---|');
  for (const u of i.verdicts.units) {
    const verdict = rejected.has(u.unit) ? `${u.verdict} (review-rejected)` : u.verdict === 'not-needed' ? `not-needed (${u.reason})` : u.verdict;
    out.push(`| \`${cell(u.path, repo)}\` ${cell(u.unit, repo)} | ${verdict} | ${u.kind ?? ''} | ${u.tests.map((t) => cell(t, repo)).join('<br>')} | ${u.attempts} |`);
  }
  const flagged = i.verdicts.units.filter((u) => u.verdict === 'flagged-defect' && u.defect);
  if (flagged.length) {
    out.push('', '#### Defects as flagged by the author');
    for (const u of flagged) out.push(`- ${cell(u.unit, repo)}: expected ${cell(u.defect!.expected, repo)}, received ${cell(u.defect!.received, repo)} (${cell(u.defect!.source, repo)})`);
  }
  return out.join('\n');
}

export function renderReviewer(i: Inputs, repo: string): string {
  const out = [MARKERS.reviewer, '### Test reviewer', header(i.ctx), ''];
  if (!i.review) {
    const why = i.verdicts ? 'the author produced no tests or defects to review' : whyNoAgent(i);
    return [...out, notRun(i, 'Reviewer', why)].join('\n');
  }
  out.push(sanitize(i.review.summary, repo), '', '#### Defect decisions');
  out.push(...(i.review.defects.length
    ? ['| Unit | Decision | Source quote |', '|---|---|---|', ...i.review.defects.map((d) => `| ${cell(d.unit, repo)} | ${d.decision} | ${cell(d.source_quote, repo)} |`)]
    : ['No defects to decide.']));
  out.push('', '#### Findings');
  out.push(...(i.review.findings.length
    ? ['| Test | Severity | Reason | Note |', '|---|---|---|---|', ...i.review.findings.map((f) => `| ${cell(f.test, repo)} | ${f.severity} | ${f.reason} | ${cell(f.note, repo)}${f.severity === 'blocking' ? ' (test file dropped from bot commit)' : ''} |`)]
    : ['No findings.']));
  return out.join('\n');
}

async function upsert(repo: string, pr: number, marker: string, body: string) {
  const text = body.length > 60000 ? body.slice(0, 60000) + '\n\n(truncated)' : body;
  for (let page = 1; page <= 20; page++) {
    const comments = await api<any[]>(`/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    const mine = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(marker));
    if (mine) return api(`/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body: text } });
    if (comments.length < 100) break;
  }
  return api(`/repos/${repo}/issues/${pr}/comments`, { method: 'POST', body: { body: text } });
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args[args.indexOf('--dir') + 1];
  if (args.indexOf('--dir') < 0 || !dir) {
    console.error('usage: report.ts --dir <artifacts> [--post]');
    process.exit(64);
  }
  const load = (name: string) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : undefined);
  const ctx: Context = load('context.json');
  if (!ctx) {
    console.error('report: context.json is required');
    process.exit(1);
  }
  const inputs: Inputs = { ctx, scope: load('scope.json'), verdicts: load('verdicts.json'), review: load('review.json'), checked: load('checked.json'), results: load('results.json') };
  const repo = process.env.GITHUB_REPOSITORY ?? '';

  const status = decide(inputs);
  const bodies = { report: renderReport(inputs, repo), author: renderAuthor(inputs, repo), reviewer: renderReviewer(inputs, repo) };
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2) + '\n');
  for (const [name, body] of Object.entries(bodies)) writeFileSync(join(dir, `${name}.md`), body + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, bodies.report + '\n');
  console.log(`report: ${status.state}: ${status.description}`);

  if (args.includes('--post') && ctx.same_repo) {
    await api(`/repos/${repo}/statuses/${ctx.final_sha}`, { method: 'POST', body: { state: status.state, context: STATUS_CONTEXT, description: status.description, target_url: ctx.run_url } });
    for (const name of ['report', 'author', 'reviewer'] as const) await upsert(repo, ctx.pr, MARKERS[name], bodies[name]);
  }
}

if (import.meta.main) await main();
