// prepare job: validate budget variables, read the live PR, decide label skip, write scope.json.
// Usage: node prepare.ts [--out scope.json]
// Env: the 5 TEST_AGENT_* variables, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, GITHUB_EVENT_NAME,
//      EVENT_ACTION and EVENT_LABEL (label events only), TEST_AGENT_SKIP_ACTORS (optional fallback).
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { api } from './github.ts';
import { classify, LABEL_SKIP_PHRASE, SKIP_LABEL, STATUS_CONTEXT } from './rules.ts';
import type { Pkg, SkipReason } from './rules.ts';

const BUDGET_VARS = [
  'TEST_AGENT_MODEL',
  'TEST_AGENT_REVIEWER_MODEL',
  'TEST_AGENT_MAX_TURNS',
  'TEST_AGENT_TIMEOUT_MINUTES',
  'TEST_AGENT_MAX_ATTEMPTS',
] as const;
const NUMERIC_VARS: readonly string[] = ['TEST_AGENT_MAX_TURNS', 'TEST_AGENT_TIMEOUT_MINUTES', 'TEST_AGENT_MAX_ATTEMPTS'];
const MAINTAINER_ROLES = ['admin', 'maintain'];

export type Hunk = { start: number; count: number };
export type CandidateStatus = 'added' | 'modified';
export type FileStatus = CandidateStatus | 'deleted';
export type DiffFile = { path: string; status: FileStatus; hunks: Hunk[] };
export type Candidate = { path: string; package: Pkg; status: CandidateStatus; hunks: Hunk[] };
export type Skipped = { path: string; reason: SkipReason };
export type Budgets = {
  model: string;
  reviewerModel: string;
  maxTurns: number;
  timeoutMinutes: number;
  maxAttempts: number;
};
export type Scope = {
  base: string;
  head: string;
  budgets: Budgets;
  candidates: Candidate[];
  skipped: Skipped[];
};

function fail(message: string): never {
  console.error(`prepare: ${message}`);
  process.exit(1);
}

function readBudgets(): Budgets {
  const problems: string[] = [];
  const value = (name: string) => (process.env[name] ?? '').trim();
  for (const name of BUDGET_VARS) {
    if (!value(name)) problems.push(`missing required repo variable ${name}`);
    else if (NUMERIC_VARS.includes(name) && !/^[1-9]\d*$/.test(value(name))) {
      problems.push(`${name} must be a positive integer, got "${value(name)}"`);
    }
  }
  if (problems.length) {
    fail(`${problems.join('; ')}. Set them with scripts/setup-github.sh config.`);
  }
  return {
    model: value('TEST_AGENT_MODEL'),
    reviewerModel: value('TEST_AGENT_REVIEWER_MODEL'),
    maxTurns: Number(value('TEST_AGENT_MAX_TURNS')),
    timeoutMinutes: Number(value('TEST_AGENT_TIMEOUT_MINUTES')),
    maxAttempts: Number(value('TEST_AGENT_MAX_ATTEMPTS')),
  };
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) files.push({ path: header[1], status: 'modified', hunks: [] });
    const file = files.at(-1);
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) file.hunks.push({ start: Number(hunk[1]), count: hunk[2] === undefined ? 1 : Number(hunk[2]) });
  }
  return files;
}

function buildScope(base: string, head: string, budgets: Budgets): Scope {
  const diff = execFileSync('git', ['diff', '-U0', '--no-color', '--no-renames', `${base}...${head}`], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const scope: Scope = { base, head, budgets, candidates: [], skipped: [] };
  for (const file of parseDiff(diff)) {
    const result = classify(file.path);
    if (file.status === 'deleted') scope.skipped.push({ path: file.path, reason: 'deleted' });
    else if (result.kind === 'skip') scope.skipped.push({ path: file.path, reason: result.reason });
    else scope.candidates.push({ path: file.path, package: result.package, status: file.status, hunks: file.hunks });
  }
  return scope;
}

// Who applied the skip label, and may their label be honoured (admin or maintain)?
async function labelDecision(repo: string, pr: number): Promise<{ actor: string; honoured: boolean }> {
  const fallback = (process.env.TEST_AGENT_SKIP_ACTORS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let actor = '';
  try {
    for (let page = 1; page <= 10; page++) {
      const events = await api<any[]>(`/repos/${repo}/issues/${pr}/events?per_page=100&page=${page}`);
      for (const event of events) {
        if (event.event === 'labeled' && event.label?.name === SKIP_LABEL) actor = event.actor?.login ?? actor;
      }
      if (events.length < 100) break;
    }
    if (!actor) return { actor, honoured: false };
    const permission = await api<any>(`/repos/${repo}/collaborators/${actor}/permission`);
    return { actor, honoured: MAINTAINER_ROLES.includes(permission.role_name ?? permission.permission) };
  } catch (error) {
    console.error(`prepare: cannot read label actor or permission (${(error as Error).message}); using TEST_AGENT_SKIP_ACTORS`);
    return { actor, honoured: actor !== '' && fallback.includes(actor) };
  }
}

async function headIsLabelSkip(repo: string, sha: string): Promise<boolean> {
  const statuses = await api<any[]>(`/repos/${repo}/commits/${sha}/statuses?per_page=100`);
  const latest = statuses.find((status) => status.context === STATUS_CONTEXT);
  return Boolean(latest?.description?.includes(LABEL_SKIP_PHRASE));
}

function writeOutputs(outputs: Record<string, string | boolean>) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

async function main() {
  const budgets = readBudgets();
  const repo = process.env.GITHUB_REPOSITORY ?? fail('GITHUB_REPOSITORY is not set');
  const number = process.env.PR_NUMBER ?? fail('PR_NUMBER is not set');
  const event = process.env.GITHUB_EVENT_NAME ?? '';
  const action = process.env.EVENT_ACTION ?? '';
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex > 0 ? process.argv[outIndex + 1] : 'scope.json';

  const pr = await api<any>(`/repos/${repo}/pulls/${number}`);
  const head: string = pr.head.sha;
  const base: string = pr.base.sha;
  const sameRepo = pr.head.repo?.full_name === repo;
  if (event === 'workflow_dispatch' && !sameRepo) fail(`PR #${number} comes from a fork; dispatch is not allowed`);

  const hasLabel = pr.labels.some((label: any) => label.name === SKIP_LABEL);
  const decision = hasLabel ? await labelDecision(repo, Number(number)) : { actor: '', honoured: false };
  const labelSkip = hasLabel && decision.honoured;

  let stop = false;
  if ((action === 'labeled' || action === 'unlabeled') && process.env.EVENT_LABEL !== SKIP_LABEL) stop = true;
  else if (action === 'labeled') stop = !labelSkip;
  else if (action === 'unlabeled') stop = !(await headIsLabelSkip(repo, head));
  if (stop) console.log(`prepare: ${action} ${process.env.EVENT_LABEL} on #${number} needs no run`);

  const scope = buildScope(base, head, budgets);
  writeFileSync(out, JSON.stringify(scope, null, 2) + '\n');

  const hasCandidates = scope.candidates.length > 0;
  writeOutputs({
    stop,
    head_sha: head,
    base_sha: base,
    same_repo: sameRepo,
    draft: Boolean(pr.draft),
    label_skip: labelSkip,
    label_actor: labelSkip ? decision.actor : '',
    has_candidates: hasCandidates,
    run_agent: !stop && hasCandidates && sameRepo && !pr.draft && !labelSkip,
  });
}

if (import.meta.main) await main();
