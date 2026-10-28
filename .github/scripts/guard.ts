// Write guard: the agent may only touch test paths (see rules.ts).
//   guard.ts hook          PreToolUse hook; reads the tool call as JSON on stdin.
//                          Exit 2 + reason on stderr blocks the call.
//   guard.ts patch <file>  Exit 1 if a git patch touches a non-test path or adds a symlink.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { isTestPath } from './rules.ts';

const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function block(reason: string): never {
  console.error(`guard: ${reason}`);
  process.exit(2);
}

// Resolve symlinks of the nearest existing ancestor, so a link cannot smuggle a write out of a test path.
function realTarget(absolute: string): string {
  const missing: string[] = [];
  let current = absolute;
  while (!existsSync(current) && dirname(current) !== current) {
    missing.unshift(current.slice(dirname(current).length + 1));
    current = dirname(current);
  }
  return resolve(realpathSync(current), ...missing);
}

function hook() {
  let call: any;
  try {
    call = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    block('hook input is not valid JSON');
  }
  if (!WRITE_TOOLS.includes(call?.tool_name)) return;

  const input = call.tool_input ?? {};
  const target = input.file_path ?? input.notebook_path;
  if (typeof target !== 'string' || !target) block(`${call.tool_name} call has no file path`);

  const root = realpathSync(process.env.CLAUDE_PROJECT_DIR ?? call.cwd ?? process.cwd());
  const path = relative(root, realTarget(resolve(call.cwd ?? root, target)));
  if (path.startsWith('..') || !isTestPath(path)) {
    block(`${call.tool_name} to ${target} refused: only test files may be written (rules.ts)`);
  }
}

// Paths named by a unified git patch, in any header that can introduce a file.
export function patchPaths(patch: string): { paths: string[]; symlinks: string[] } {
  const paths = new Set<string>();
  const symlinks: string[] = [];
  let current = '';
  for (const line of patch.split('\n')) {
    const diff = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
    if (diff) {
      paths.add(diff[1]);
      paths.add(diff[2]);
      current = diff[2];
      continue;
    }
    const named = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line) ?? /^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/.exec(line);
    if (named && named[1] !== '/dev/null') paths.add(named[1]);
    if (/^(?:new file mode|new mode) 120000$/.test(line)) symlinks.push(current);
  }
  return { paths: [...paths], symlinks };
}

function patch(file: string | undefined) {
  if (!file) {
    console.error('usage: guard.ts patch <file>');
    process.exit(64);
  }
  const { paths, symlinks } = patchPaths(readFileSync(file, 'utf8'));
  const bad = paths.filter((path) => path.includes('..') || path.startsWith('/') || path.startsWith('"') || !isTestPath(path));
  if (bad.length || symlinks.length) {
    for (const path of bad) console.error(`guard: patch touches non-test path ${path}`);
    for (const path of symlinks) console.error(`guard: patch creates symlink ${path}`);
    process.exit(1);
  }
  console.log(`guard: patch ok (${paths.length} paths)`);
}

if (import.meta.main) {
  const [mode, arg] = process.argv.slice(2);
  if (mode === 'hook') hook();
  else if (mode === 'patch') patch(arg);
  else {
    console.error('usage: guard.ts <hook|patch <file>>');
    process.exit(64);
  }
}
