// prepare job: validate budget variables, read the live PR, decide label skip, write scope.json.
// Usage: node prepare.ts [--out scope.json]
//        node prepare.ts --local <base> [--out scope.json]   scope for `git diff <base>...HEAD`, no GitHub calls
// Env: the 5 TEST_AGENT_* variables, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, GITHUB_EVENT_NAME,
//      EVENT_ACTION and EVENT_LABEL (label events only), TEST_AGENT_SKIP_ACTORS (optional fallback).
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { die } from './cli.ts';
import { github } from './github.ts';
import type { GitHub } from './github.ts';
import { classify, LABEL_SKIP_PHRASE, SKIP_LABEL, STATUS_CONTEXT } from './rules.ts';
import type { Pkg, SkipReason } from './rules.ts';
import { scanLines } from './scan.ts';
import type { LineRule } from './scan.ts';

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

type Env = Record<string, string | undefined>;
type LabelEvent = { action: string; label: string };
type LabelDecision = { actor: string; honoured: boolean };

// The parts of GitHub API responses this script reads.
type PullRequest = {
  head: { sha: string; repo: { full_name: string } | null };
  base: { sha: string };
  draft: boolean;
  labels: { name: string }[];
};
type IssueEvent = { event: string; label?: { name: string }; actor?: { login: string } };
type Permission = { permission: string; role_name?: string };
type CommitStatus = { context: string; description: string | null };

const SCRIPT = 'prepare';
const MAINTAINER_ROLES = ['admin', 'maintain'];
const MAX_EVENT_PAGES = 10;

// ---- Budgets ----

type BudgetField = 'model' | 'reviewerModel' | 'maxTurns' | 'timeoutMinutes' | 'maxAttempts';
type BudgetKind = 'text' | 'count';
type BudgetVar = { env: string; field: BudgetField; kind: BudgetKind };
type BudgetFormat = { valid: (value: string) => boolean; expected: string; parse: (value: string) => string | number };

const BUDGET_VARS: readonly BudgetVar[] = [
  { env: 'TEST_AGENT_MODEL', field: 'model', kind: 'text' },
  { env: 'TEST_AGENT_REVIEWER_MODEL', field: 'reviewerModel', kind: 'text' },
  { env: 'TEST_AGENT_MAX_TURNS', field: 'maxTurns', kind: 'count' },
  { env: 'TEST_AGENT_TIMEOUT_MINUTES', field: 'timeoutMinutes', kind: 'count' },
  { env: 'TEST_AGENT_MAX_ATTEMPTS', field: 'maxAttempts', kind: 'count' },
];
const BUDGET_FORMATS: Record<BudgetKind, BudgetFormat> = {
  text: { valid: () => true, expected: 'text', parse: String },
  count: { valid: (value) => /^[1-9]\d*$/.test(value), expected: 'a positive integer', parse: Number },
};

function budgetProblem(budget: BudgetVar, value: string): string | undefined {
  if (!value) return `missing required repo variable ${budget.env}`;
  const format = BUDGET_FORMATS[budget.kind];
  return format.valid(value) ? undefined : `${budget.env} must be ${format.expected}, got "${value}"`;
}

function readBudgets(env: Env): Budgets {
  const value = (budget: BudgetVar) => (env[budget.env] ?? '').trim();
  const problems = BUDGET_VARS.map((budget) => budgetProblem(budget, value(budget))).filter((problem) => problem !== undefined);
  if (problems.length) die(SCRIPT, `${problems.join('; ')}. Set them with scripts/setup-github.sh config.`);
  const fields = BUDGET_VARS.map((budget) => [budget.field, BUDGET_FORMATS[budget.kind].parse(value(budget))]);
  return Object.fromEntries(fields) as Budgets;
}

// ---- Diff → scope ----

const setStatus = (files: DiffFile[], status: FileStatus) => {
  const file = files.at(-1);
  if (file) file.status = status;
};

// With --no-renames both header paths are equal; the backreference keeps paths containing " b/" whole.
// Paths git still quotes (tabs, newlines, quotes) match no rule and are left out of the scope.
const DIFF_LINES: readonly LineRule<DiffFile[]>[] = [
  { pattern: /^diff --git a\/(.+) b\/\1$/, apply: (files, [, path]) => files.push({ path, status: 'modified', hunks: [] }) },
  { pattern: /^new file mode/, apply: (files) => setStatus(files, 'added') },
  { pattern: /^deleted file mode/, apply: (files) => setStatus(files, 'deleted') },
  {
    pattern: /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/,
    apply: (files, [, start, count]) => files.at(-1)?.hunks.push({ start: Number(start), count: Number(count ?? 1) }),
  },
];

const parseDiff = (diff: string): DiffFile[] => scanLines(diff, DIFF_LINES, []);

function buildScope(base: string, head: string, budgets: Budgets): Scope {
  const diff = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-renames', `${base}...${head}`],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const scope: Scope = { base, head, budgets, candidates: [], skipped: [] };
  for (const file of parseDiff(diff)) {
    if (file.status === 'deleted') {
      scope.skipped.push({ path: file.path, reason: 'deleted' });
      continue;
    }
    const result = classify(file.path);
    switch (result.kind) {
      case 'skip':
        scope.skipped.push({ path: file.path, reason: result.reason });
        break;
      case 'candidate':
        scope.candidates.push({ path: file.path, package: result.package, status: file.status, hunks: file.hunks });
        break;
    }
  }
  return scope;
}

// ---- Skip label ----

async function skipLabelActor(gh: GitHub, repo: string, prNumber: string): Promise<string> {
  const events = await gh.paginate<IssueEvent>(`/repos/${repo}/issues/${prNumber}/events`, MAX_EVENT_PAGES);
  const latest = events.findLast((event) => event.event === 'labeled' && event.label?.name === SKIP_LABEL);
  return latest?.actor?.login ?? '';
}

// Who applied the skip label, and may their label be honoured (admin or maintain)?
// If the API can't tell, fall back to the admin-set list of logins.
async function labelDecision(gh: GitHub, repo: string, prNumber: string, fallbackActors: string[]): Promise<LabelDecision> {
  let actor = '';
  try {
    actor = await skipLabelActor(gh, repo, prNumber);
    if (!actor) return { actor, honoured: false };
    const permission = await gh.request<Permission>(`/repos/${repo}/collaborators/${actor}/permission`);
    return { actor, honoured: MAINTAINER_ROLES.includes(permission.role_name ?? permission.permission) };
  } catch (error) {
    console.error(`${SCRIPT}: cannot read label actor or permission (${(error as Error).message}); using TEST_AGENT_SKIP_ACTORS`);
    return { actor, honoured: actor !== '' && fallbackActors.includes(actor) };
  }
}

async function headIsLabelSkip(gh: GitHub, repo: string, sha: string): Promise<boolean> {
  const statuses = await gh.request<CommitStatus[]>(`/repos/${repo}/commits/${sha}/statuses?per_page=100`);
  const latest = statuses.find((status) => status.context === STATUS_CONTEXT);
  return Boolean(latest?.description?.includes(LABEL_SKIP_PHRASE));
}

// Label events start a run only for the skip label: adding it when honoured, removing it when the head was skipped.
async function stopForLabelEvent(gh: GitHub, repo: string, head: string, event: LabelEvent, labelSkip: boolean): Promise<boolean> {
  const isSkipLabel = event.label === SKIP_LABEL;
  switch (event.action) {
    case 'labeled':
      return !isSkipLabel || !labelSkip;
    case 'unlabeled':
      return !isSkipLabel || !(await headIsLabelSkip(gh, repo, head));
    default:
      return false;
  }
}

// ---- Main ----

function revParse(ref: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  } catch {
    return die(SCRIPT, `unknown git ref "${ref}"`, 'usage');
  }
}

// Local trial run: same budgets and rules as CI, but no PR, label or status logic.
function local(base: string, out: string, env: Env) {
  const budgets = readBudgets(env);
  const scope = buildScope(revParse(base), revParse('HEAD'), budgets);
  writeFileSync(out, JSON.stringify(scope, null, 2) + '\n');
  console.log(`${SCRIPT}: ${scope.candidates.length} candidates, ${scope.skipped.length} skipped → ${out}`);
}

function writeOutputs(outputFile: string | undefined, outputs: Record<string, string | boolean>) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  if (outputFile) appendFileSync(outputFile, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

async function main(env: Env) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'scope.json' }, local: { type: 'string' } } });
  if (values.local !== undefined) return local(values.local, values.out, env);
  const read = (name: string) => (env[name] ?? '').trim();
  const budgets = readBudgets(env);
  const repo = read('GITHUB_REPOSITORY') || die(SCRIPT, 'GITHUB_REPOSITORY is not set');
  const prNumber = read('PR_NUMBER') || die(SCRIPT, 'PR_NUMBER is not set');
  const labelEvent: LabelEvent = { action: read('EVENT_ACTION'), label: read('EVENT_LABEL') };
  const fallbackActors = read('TEST_AGENT_SKIP_ACTORS').split(',').map((login) => login.trim());
  const token = read('GITHUB_TOKEN') || die(SCRIPT, 'GITHUB_TOKEN is not set');
  const gh = github({ token, baseUrl: read('GITHUB_API_URL') || undefined });

  const pr = await gh.request<PullRequest>(`/repos/${repo}/pulls/${prNumber}`);
  const head = pr.head.sha;
  const base = pr.base.sha;
  const sameRepo = pr.head.repo?.full_name === repo;
  if (read('GITHUB_EVENT_NAME') === 'workflow_dispatch' && !sameRepo) {
    die(SCRIPT, `PR #${prNumber} comes from a fork; dispatch is not allowed`);
  }

  const hasLabel = pr.labels.some((label) => label.name === SKIP_LABEL);
  const decision = hasLabel ? await labelDecision(gh, repo, prNumber, fallbackActors) : { actor: '', honoured: false };
  const labelSkip = hasLabel && decision.honoured;

  const stop = await stopForLabelEvent(gh, repo, head, labelEvent, labelSkip);
  if (stop) console.log(`${SCRIPT}: ${labelEvent.action} ${labelEvent.label} on #${prNumber} needs no run`);

  const scope = buildScope(base, head, budgets);
  writeFileSync(values.out, JSON.stringify(scope, null, 2) + '\n');

  const hasCandidates = scope.candidates.length > 0;
  writeOutputs(env.GITHUB_OUTPUT, {
    stop,
    head_sha: head,
    base_sha: base,
    same_repo: sameRepo,
    draft: pr.draft,
    label_skip: labelSkip,
    label_actor: labelSkip ? decision.actor : '',
    has_candidates: hasCandidates,
    run_agent: !stop && hasCandidates && sameRepo && !pr.draft && !labelSkip,
  });
}

if (import.meta.main) await main(process.env);
