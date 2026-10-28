// Write guard: the agent may only touch test paths (see rules.ts).
//   guard.ts hook          PreToolUse hook; reads the tool call as JSON on stdin.
//                          Exit 2 + reason on stderr blocks the call.
//   guard.ts patch <file>  Exit 1 if a git patch touches a non-test path or adds a symlink.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { die } from './cli.ts';
import { isTestPath } from './rules.ts';
import { scanLines } from './scan.ts';
import type { LineRule } from './scan.ts';

type HookInput = {
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string };
  cwd?: string;
};
type PatchScan = { paths: Set<string>; symlinks: string[]; current: string };

const SCRIPT = 'guard';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function block(reason: string): never {
  return die(SCRIPT, reason, 'blocked');
}

// Resolve symlinks of the nearest existing ancestor, so a link cannot smuggle a write out of a test path.
function realTarget(absolute: string): string {
  const missing: string[] = [];
  let current = absolute;
  while (!existsSync(current) && dirname(current) !== current) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  return resolve(realpathSync(current), ...missing);
}

function readHookInput(): HookInput {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    block('hook input is not valid JSON');
  }
}

function hook(projectDir: string | undefined) {
  const call = readHookInput();
  if (!WRITE_TOOLS.has(call.tool_name ?? '')) return;

  const target = call.tool_input?.file_path ?? call.tool_input?.notebook_path;
  if (!target) block(`${call.tool_name} call has no file path`);

  const root = realpathSync(projectDir ?? call.cwd ?? process.cwd());
  const path = relative(root, realTarget(resolve(call.cwd ?? root, target)));
  if (path.startsWith('..') || !isTestPath(path)) {
    block(`${call.tool_name} to ${target} refused: only test files may be written (rules.ts)`);
  }
}

// Every header that can introduce a file.
const PATCH_LINES: readonly LineRule<PatchScan>[] = [
  {
    pattern: /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/,
    apply: (scan, [, from, to]) => {
      scan.paths.add(from).add(to);
      scan.current = to;
    },
  },
  { pattern: /^(?:rename|copy) (?:from|to) (.+)$/, apply: (scan, [, path]) => scan.paths.add(path) },
  { pattern: /^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/, apply: (scan, [, path]) => path !== '/dev/null' && scan.paths.add(path) },
  { pattern: /^(?:new file mode|new mode) 120000$/, apply: (scan) => scan.symlinks.push(scan.current) },
];

function patchPaths(patch: string): { paths: string[]; symlinks: string[] } {
  const scan = scanLines<PatchScan>(patch, PATCH_LINES, { paths: new Set(), symlinks: [], current: '' });
  return { paths: [...scan.paths], symlinks: scan.symlinks };
}

const isSafeTestPath = (path: string) =>
  !path.includes('..') && !path.startsWith('/') && !path.startsWith('"') && isTestPath(path);

function patch(file: string | undefined) {
  if (!file) die(SCRIPT, 'usage: guard.ts patch <file>', 'usage');
  const { paths, symlinks } = patchPaths(readFileSync(file, 'utf8'));
  const bad = paths.filter((path) => !isSafeTestPath(path));
  for (const path of bad) console.error(`${SCRIPT}: patch touches non-test path ${path}`);
  for (const path of symlinks) console.error(`${SCRIPT}: patch creates symlink ${path}`);
  if (bad.length || symlinks.length) die(SCRIPT, 'patch rejected');
  console.log(`${SCRIPT}: patch ok (${paths.length} paths)`);
}

if (import.meta.main) {
  const [mode, arg] = process.argv.slice(2);
  switch (mode) {
    case 'hook':
      hook(process.env.CLAUDE_PROJECT_DIR);
      break;
    case 'patch':
      patch(arg);
      break;
    default:
      die(SCRIPT, 'usage: guard.ts <hook|patch <file>>', 'usage');
  }
}
