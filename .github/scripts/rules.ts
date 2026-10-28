// Single declarative rule set: where tests live, which changed files are skipped and why.
// Docs link here instead of copying these lists.

export const PACKAGES = ['backend', 'frontend'] as const;
export type Pkg = (typeof PACKAGES)[number];

export const SKIP_LABEL = 'skip-test-agent';
export const STATUS_CONTEXT = 'test-agent/verify';
export const LABEL_SKIP_PHRASE = 'skipped by label';

// The only paths the agent may write.
export const TEST_PATHS: Record<Pkg, readonly string[]> = {
  backend: ['backend/tests/**'],
  frontend: ['frontend/src/**/*.test.ts', 'frontend/src/**/*.test.tsx', 'frontend/src/test/**'],
};

// Changed files that can hold units worth testing.
export const SOURCE_PATHS: Record<Pkg, readonly string[]> = {
  backend: ['backend/src/**/*.ts'],
  frontend: ['frontend/src/**/*.ts', 'frontend/src/**/*.tsx'],
};

export const SKIP_REASONS = [
  'tests',
  'stories',
  'generated',
  'lockfiles',
  'docs',
  'config',
  'type-only',
  'barrel',
  'deleted',
  'not-source',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

// First match wins. `tests` is derived from TEST_PATHS and checked before this list.
export const SKIP_RULES: readonly { reason: SkipReason; patterns: readonly string[] }[] = [
  { reason: 'stories', patterns: ['**/*.stories.tsx', '**/*.stories.ts'] },
  { reason: 'generated', patterns: ['backend/src/generated/**'] },
  { reason: 'lockfiles', patterns: ['**/package-lock.json', '**/*.lock'] },
  { reason: 'docs', patterns: ['**/*.md', 'docs/**'] },
  {
    reason: 'config',
    patterns: [
      '.github/**',
      '.claude/**',
      '**/*.json',
      '**/*.yaml',
      '**/*.yml',
      '**/*.css',
      '**/*.config.*',
      '**/Dockerfile',
      '**/.*',
      'backend/prisma/**',
      'frontend/.storybook/**',
      'frontend/index.html',
      'frontend/vite.config.ts',
    ],
  },
  { reason: 'type-only', patterns: ['**/types.ts', '**/*.types.ts', '**/*.d.ts'] },
  { reason: 'barrel', patterns: ['**/index.ts'] },
];

function toRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const rest = glob.slice(i);
    if (rest.startsWith('**/')) { source += '(?:.*/)?'; i += 2; }
    else if (rest.startsWith('**')) { source += '.*'; i += 1; }
    else if (glob[i] === '*') source += '[^/]*';
    else source += glob[i].replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function matches(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => toRegExp(pattern).test(path));
}

export function isTestPath(path: string): boolean {
  return PACKAGES.some((pkg) => matches(path, TEST_PATHS[pkg]));
}

export type Classification =
  | { kind: 'candidate'; package: Pkg }
  | { kind: 'skip'; reason: SkipReason };

export function classify(path: string): Classification {
  if (isTestPath(path)) return { kind: 'skip', reason: 'tests' };
  for (const rule of SKIP_RULES) {
    if (matches(path, rule.patterns)) return { kind: 'skip', reason: rule.reason };
  }
  for (const pkg of PACKAGES) {
    if (matches(path, SOURCE_PATHS[pkg])) return { kind: 'candidate', package: pkg };
  }
  return { kind: 'skip', reason: 'not-source' };
}
