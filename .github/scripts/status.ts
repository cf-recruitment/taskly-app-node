// The final test-agent/verify status, decided from the run's artifacts.
import { unitKey, writesTests } from './agent-output.ts';
import type { AuthorOutput, Checked, ReviewerOutput, Unit } from './agent-output.ts';
import type { Scope } from './prepare.ts';
import { LABEL_SKIP_PHRASE } from './rules.ts';

export type JobResult = 'success' | 'failure' | 'cancelled' | 'skipped';
export type Job = 'prepare' | 'engineer' | 'commit' | 'verify';
export type StatusState = 'success' | 'failure';
export type Status = { state: StatusState; description: string };
export type Context = {
  pr: number;
  analyzed_sha: string;
  final_sha: string;
  run_url: string;
  same_repo: boolean;
  label_skip: boolean;
  label_actor: string;
  run_agent: boolean;
  jobs: Record<Job, JobResult>;
};
export type Check = 'pass' | 'fail' | 'skipped';
export type CoverageFigures = { lines: number; branches: number };
export type Coverage = Record<string, Record<string, CoverageFigures>>;
export type SuiteResult = { status: Check; passed: number; failed: number };
export type Mutant = { file: string; line: number; mutator: string };
export type MutationResult = { score: number; survived: Mutant[] };
export type Results = {
  typecheck: Record<string, Check>;
  tests: Record<string, SuiteResult>;
  coverage: { baseline: Coverage; final: Coverage };
  mutation: Record<string, MutationResult | null>;
};
// Everything one pipeline run produced; each artifact is missing if its job did not get that far.
export type Run = {
  context: Context;
  scope?: Scope;
  author?: AuthorOutput;
  reviewer?: ReviewerOutput;
  checked?: Checked;
  results?: Results;
};
// An ordered list of conditions; the first one that holds gives the reason.
export type ReasonRule = { when: (run: Run) => boolean; reason: (run: Run) => string };

// GitHub's limit for a commit status description.
const MAX_STATUS_DESCRIPTION = 140;
export const PREPARE_FAILED = 'prepare failed';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
export const firstReason = (rules: readonly ReasonRule[], run: Run) => rules.find((rule) => rule.when(run))?.reason(run);
export const labelSkipNote = (context: Context) => `${LABEL_SKIP_PHRASE} (@${context.label_actor})`;

function confirmedDefects(run: Run): Unit[] {
  const confirmed = new Set((run.reviewer?.defects ?? []).filter((defect) => defect.decision === 'confirmed').map(unitKey));
  return (run.author?.units ?? []).filter((unit) => unit.verdict === 'flagged-defect' && confirmed.has(unitKey(unit)));
}

// The first agent step that failed explains the agent part.
const AGENT_FAILURES: readonly ReasonRule[] = [
  { when: (run) => run.context.jobs.engineer !== 'success', reason: () => 'author or reviewer did not finish' },
  { when: (run) => run.context.jobs.commit !== 'success', reason: () => 'commit step failed' },
  { when: (run) => !run.author || !run.checked, reason: () => 'agent output missing' },
  { when: (run) => !run.checked?.ok, reason: () => 'agent output invalid or patch rejected' },
];

function verifyFailure(run: Run): string | undefined {
  if (run.context.jobs.verify !== 'success' || !run.results) return 'verification did not finish';
  const failed = [
    ...Object.entries(run.results.typecheck).filter(([, check]) => check === 'fail').map(([pkg]) => `${pkg} typecheck`),
    ...Object.entries(run.results.tests).filter(([, suite]) => suite.status === 'fail').map(([pkg]) => `${pkg} tests`),
  ];
  return failed.length ? `${failed.join(', ')} failed` : undefined;
}

function headline(run: Run): string {
  if (!run.context.run_agent) return 'no agent run; suites pass';
  const rejected = new Set(run.checked?.reviewRejected ?? []);
  const tested = (run.author?.units ?? []).filter((unit) => writesTests(unit.verdict) && !rejected.has(unitKey(unit))).length;
  return `${plural(tested, 'unit')} tested, ${plural(confirmedDefects(run).length, 'confirmed defect')}`;
}

export function decide(run: Run): Status {
  const defects = confirmedDefects(run).length;
  const reasons = [
    run.context.jobs.prepare !== 'success' ? PREPARE_FAILED : undefined,
    run.context.run_agent ? firstReason(AGENT_FAILURES, run) : undefined,
    verifyFailure(run),
    defects ? plural(defects, 'confirmed defect') : undefined,
  ].filter((reason) => reason !== undefined);

  const prefix = run.context.label_skip ? `${labelSkipNote(run.context)}; ` : '';
  const summary = reasons.length ? reasons.join('; ') : headline(run);
  return { state: reasons.length ? 'failure' : 'success', description: (prefix + summary).slice(0, MAX_STATUS_DESCRIPTION) };
}
