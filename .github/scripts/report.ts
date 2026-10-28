// publish job: decide the final status, render the 3 sticky PR comments and the job summary.
// Usage: node report.ts --dir <artifacts> [--post]
// Reads from <dir>: context.json (required), scope.json, author.json, reviewer.json, checked.json, results.json.
// Writes to <dir>: status.json, report.md, author.md, reviewer.md. --post also writes status + comments to GitHub.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { die } from './cli.ts';
import { github } from './github.ts';
import type { GitHub } from './github.ts';
import { COMMENTS, MARKERS, renderAuthor, renderReport, renderReviewer } from './render.ts';
import type { CommentName } from './render.ts';
import { STATUS_CONTEXT } from './rules.ts';
import { decide } from './status.ts';
import type { Context, Run, Status } from './status.ts';

type IssueComment = { id: number; user: { login: string } | null; body?: string };

const SCRIPT = 'report';
const BOT_LOGIN = 'github-actions[bot]';
// GitHub rejects comment bodies over 65536 characters; keep room for the truncation note.
const MAX_COMMENT = 60000;
const MAX_COMMENT_PAGES = 20;

async function upsert(gh: GitHub, repo: string, pr: number, marker: string, body: string) {
  const text = body.length > MAX_COMMENT ? body.slice(0, MAX_COMMENT) + '\n\n(truncated)' : body;
  const comments = await gh.paginate<IssueComment>(`/repos/${repo}/issues/${pr}/comments`, MAX_COMMENT_PAGES);
  const mine = comments.find((comment) => comment.user?.login === BOT_LOGIN && comment.body?.startsWith(marker));
  return mine
    ? gh.request(`/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body: text } })
    : gh.request(`/repos/${repo}/issues/${pr}/comments`, { method: 'POST', body: { body: text } });
}

async function post(gh: GitHub, repo: string, context: Context, status: Status, bodies: Record<CommentName, string>) {
  await gh.request(`/repos/${repo}/statuses/${context.final_sha}`, {
    method: 'POST',
    body: { state: status.state, context: STATUS_CONTEXT, description: status.description, target_url: context.run_url },
  });
  for (const name of COMMENTS) await upsert(gh, repo, context.pr, MARKERS[name], bodies[name]);
}

async function main(env: Record<string, string | undefined>) {
  const { values } = parseArgs({ options: { dir: { type: 'string' }, post: { type: 'boolean', default: false } } });
  const dir = values.dir ?? die(SCRIPT, 'usage: report.ts --dir <artifacts> [--post]', 'usage');
  const load = (name: string) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : undefined);
  const context: Context = load('context.json') ?? die(SCRIPT, 'context.json is required');
  const run: Run = {
    context,
    scope: load('scope.json'),
    author: load('author.json'),
    reviewer: load('reviewer.json'),
    checked: load('checked.json'),
    results: load('results.json'),
  };
  const repo = env.GITHUB_REPOSITORY ?? '';

  const status = decide(run);
  const bodies: Record<CommentName, string> = {
    report: renderReport(run, repo),
    author: renderAuthor(run, repo),
    reviewer: renderReviewer(run, repo),
  };
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2) + '\n');
  for (const name of COMMENTS) writeFileSync(join(dir, `${name}.md`), bodies[name] + '\n');
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, bodies.report + '\n');
  console.log(`${SCRIPT}: ${status.state}: ${status.description}`);

  if (!values.post || !context.same_repo) return;
  const token = env.GITHUB_TOKEN || die(SCRIPT, 'GITHUB_TOKEN is not set');
  const gh = github({ token, baseUrl: env.GITHUB_API_URL || undefined });
  await post(gh, repo, context, status, bodies);
}

if (import.meta.main) await main(process.env);
