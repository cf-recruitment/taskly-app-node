#!/usr/bin/env node
// Lists source files changed against a base ref and maps each to its unit test file.
// Usage: node changed-sources.mjs [base-ref]   (default: origin/main)
// Output: JSON on stdout. Deterministic, no network, no dependencies.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const base = process.argv[2] ?? 'origin/main';
// The ref ends up in a git argv; refuse anything that could be read as an option.
if (!/^[\w./-]+$/.test(base) || base.startsWith('-')) {
  console.error(`Invalid base ref: ${base}`);
  process.exit(2);
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const raw = execFileSync('git', ['diff', '--name-status', '-z', '--find-renames', `${base}...HEAD`], { cwd: root, encoding: 'utf8' });

// -z output: STATUS\0path\0 (or R/C: STATUS\0old\0new\0)
const changes = [];
const parts = raw.split('\0').filter(Boolean);
for (let i = 0; i < parts.length; ) {
  const status = parts[i++][0];
  const file = status === 'R' || status === 'C' ? (i++, parts[i++]) : parts[i++];
  changes.push({ status, file });
}

// ponytail: mirrors coverage include/exclude in backend/vitest.config.ts and frontend/vite.config.ts by hand; keep in sync.
const projects = {
  backend: {
    source: /^backend\/src\/.+\.ts$/,
    ignore: [/\/types\.ts$/, /^backend\/src\/generated\//],
    test: /^backend\/tests\/.+\.test\.ts$/,
    testFor: (file) => `backend/tests/${path.posix.basename(file, '.ts')}.test.ts`,
  },
  frontend: {
    source: /^frontend\/src\/.+\.tsx?$/,
    ignore: [
      /\.test\.tsx?$/, /\.stories\.tsx$/, /\.styles\.ts$/, /\.variants\.ts$/, /types\.ts$/, /\/index\.ts$/,
      /constants\.tsx?$/, /^frontend\/src\/(main\.tsx|test\/|design-system\/)/,
      /^frontend\/src\/(features\/todos\/api\/queryKeys|lib\/queryClient)\.ts$/,
    ],
    test: /^frontend\/src\/.+\.test\.tsx?$/,
    testFor: (file) => file.replace(/\.(tsx?)$/, '.test.$1'),
  },
};

const result = { base, projects: {}, shouldRun: false };
for (const [name, project] of Object.entries(projects)) {
  const sources = changes
    .filter(({ file }) => project.source.test(file) && !project.ignore.some((re) => re.test(file)))
    .map(({ status, file }) => {
      const testFile = project.testFor(file);
      return { file, status, testFile, testExists: existsSync(path.join(root, testFile)) };
    });
  const changedTests = changes.filter(({ file }) => project.test.test(file)).map(({ status, file }) => ({ file, status }));
  result.projects[name] = { sources, changedTests };
  if (sources.some((s) => s.status !== 'D')) result.shouldRun = true;
}

console.log(JSON.stringify(result, null, 2));
