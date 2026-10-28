// Validates both agents' output against their schemas and computes which test files to drop.
// Usage: node verdicts.ts <verdicts.json> [--review review.json] [--max-attempts N] [--out checked.json]
// Exit 1 if anything is invalid; --out is written either way so `publish` can read it.
import { readFileSync, writeFileSync } from 'node:fs';

type Schema = {
  type: 'object' | 'array' | 'string' | 'integer' | 'boolean';
  enum?: readonly string[];
  required?: readonly string[];
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
  items?: Schema;
  maxLength?: number;
};

const readJson = (name: string) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
export const verdictsSchema: Schema = readJson('./verdicts.schema.json');
export const reviewSchema: Schema = readJson('./review.schema.json');

// Hand-validates the schema subset we use: types, required, enum, arrays, additionalProperties:false, maxLength.
export function validate(value: unknown, schema: Schema, at = '$'): string[] {
  const errors: string[] = [];
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (schema.type === 'object') {
    if (!isObject) return [`${at}: expected object`];
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) errors.push(`${at}.${key}: required`);
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) errors.push(...validate(child, childSchema, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unexpected property`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${at}: expected array`];
    if (schema.items) value.forEach((item, i) => errors.push(...validate(item, schema.items!, `${at}[${i}]`)));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${at}: expected string`];
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: "${value}" not one of ${schema.enum.join('|')}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${at}: expected integer`);
  } else if (typeof value !== 'boolean') {
    errors.push(`${at}: expected boolean`);
  }
  return errors;
}

export type Unit = {
  path: string;
  unit: string;
  verdict: 'added' | 'amended' | 'not-needed' | 'flagged-defect';
  reason?: string;
  kind?: 'intent' | 'characterization';
  expectations: { text: string; source: string }[];
  tests: string[];
  attempts: number;
  defect?: { test: string; expected: string; received: string; source: string };
};
export type Verdicts = { summary: string; units: Unit[] };
export type Review = {
  summary: string;
  findings: { test: string; severity: 'blocking' | 'advisory'; reason: string; note: string }[];
  defects: { unit: string; decision: 'confirmed' | 'rejected'; source_quote: string }[];
};
export type Checked = {
  ok: boolean;
  errors: string[];
  dropFiles: string[]; // test files with a blocking finding
  reviewRejected: string[]; // units whose tests live in a dropped file (report-only state)
};

const testFile = (test: string) => test.split(' > ')[0];

export function check(verdicts: unknown, review: unknown | undefined, maxAttempts: number): Checked {
  const errors = validate(verdicts, verdictsSchema);
  if (review !== undefined) errors.push(...validate(review, reviewSchema).map((e) => `review ${e}`));
  if (errors.length) return { ok: false, errors, dropFiles: [], reviewRejected: [] };

  const { units } = verdicts as Verdicts;
  for (const unit of units) {
    const name = `${unit.path} ${unit.unit}`;
    if (unit.attempts < 0 || unit.attempts > maxAttempts) errors.push(`${name}: attempts ${unit.attempts} outside 0..${maxAttempts}`);
    if (unit.verdict === 'not-needed' && !unit.reason) errors.push(`${name}: not-needed needs a reason`);
    if (unit.verdict !== 'not-needed' && !unit.kind) errors.push(`${name}: ${unit.verdict} needs a kind`);
    if (unit.verdict === 'flagged-defect' && !unit.defect) errors.push(`${name}: flagged-defect needs a defect`);
    if ((unit.verdict === 'added' || unit.verdict === 'amended') && unit.tests.length === 0) errors.push(`${name}: ${unit.verdict} lists no tests`);
  }

  const needsReview = units.some((u) => u.verdict !== 'not-needed');
  if (needsReview && review === undefined) errors.push('review.json is missing but the author produced tests or defects');

  const dropFiles = new Set<string>();
  if (review !== undefined) {
    const { findings, defects } = review as Review;
    const known = new Set(units.flatMap((u) => u.tests));
    for (const finding of findings) {
      if (!known.has(finding.test)) errors.push(`finding refers to unknown test "${finding.test}"`);
      else if (finding.severity === 'blocking') dropFiles.add(testFile(finding.test));
    }
    const flagged = new Set(units.filter((u) => u.verdict === 'flagged-defect').map((u) => u.unit));
    for (const defect of defects) {
      if (!flagged.has(defect.unit)) errors.push(`review decides on "${defect.unit}", which is not a flagged-defect`);
    }
    for (const unit of flagged) {
      if (!defects.some((d) => d.unit === unit)) errors.push(`flagged-defect "${unit}" has no reviewer decision`);
    }
  }

  const reviewRejected = units
    .filter((u) => (u.verdict === 'added' || u.verdict === 'amended') && u.tests.some((t) => dropFiles.has(testFile(t))))
    .map((u) => u.unit);
  return { ok: errors.length === 0, errors, dropFiles: [...dropFiles], reviewRejected };
}

function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const file = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!file) {
    console.error('usage: verdicts.ts <verdicts.json> [--review review.json] [--max-attempts N] [--out checked.json]');
    process.exit(64);
  }
  const maxAttempts = Number(option('--max-attempts') ?? process.env.TEST_AGENT_MAX_ATTEMPTS);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    console.error('verdicts: pass --max-attempts N or set TEST_AGENT_MAX_ATTEMPTS');
    process.exit(64);
  }
  const load = (path: string) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      return { __unreadable: `${path}: ${(error as Error).message}` };
    }
  };
  const verdicts = load(file);
  const reviewPath = option('--review');
  const review = reviewPath ? load(reviewPath) : undefined;
  const unreadable = [verdicts, review].filter((x) => x?.__unreadable).map((x) => `cannot read ${x.__unreadable}`);
  const result = unreadable.length ? { ok: false, errors: unreadable, dropFiles: [], reviewRejected: [] } : check(verdicts, review, maxAttempts);

  const out = option('--out');
  if (out) writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  for (const error of result.errors) console.error(`verdicts: ${error}`);
  console.log(`verdicts: ${result.ok ? 'ok' : 'INVALID'}; drop files: ${result.dropFiles.join(', ') || 'none'}; review-rejected: ${result.reviewRejected.join(', ') || 'none'}`);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.main) main();
