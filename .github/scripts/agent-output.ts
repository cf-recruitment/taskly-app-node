// Validates both agents' output against their schemas and computes which test files to drop.
// Usage: node agent-output.ts <author.json> [--reviewer reviewer.json] [--max-attempts N] [--out checked.json]
// Exit 1 if anything is invalid; --out is written either way so `publish` can read it.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { die, EXIT_CODES } from './cli.ts';

// ---- Schema validation (the subset our schemas use) ----

type SchemaType = 'object' | 'array' | 'string' | 'integer' | 'boolean';
type Schema = {
  type: SchemaType;
  enum?: readonly string[];
  required?: readonly string[];
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
  items?: Schema;
  maxLength?: number;
};
type Validator = (value: unknown, schema: Schema, at: string) => string[];

const readSchema = (name: string): Schema => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const authorSchema = readSchema('./author.schema.json');
const reviewerSchema = readSchema('./reviewer.schema.json');

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateObject: Validator = (value, schema, at) => {
  if (!isPlainObject(value)) return [`${at}: expected object`];
  const missing = (schema.required ?? []).filter((key) => !(key in value)).map((key) => `${at}.${key}: required`);
  const properties = Object.entries(value).flatMap(([key, child]) => {
    const childSchema = schema.properties?.[key];
    if (childSchema) return validate(child, childSchema, `${at}.${key}`);
    return schema.additionalProperties === false ? [`${at}.${key}: unexpected property`] : [];
  });
  return [...missing, ...properties];
};

const validateArray: Validator = (value, schema, at) => {
  if (!Array.isArray(value)) return [`${at}: expected array`];
  const items = schema.items;
  return items ? value.flatMap((item, i) => validate(item, items, `${at}[${i}]`)) : [];
};

const validateString: Validator = (value, schema, at) => {
  if (typeof value !== 'string') return [`${at}: expected string`];
  const errors: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: "${value}" not one of ${schema.enum.join('|')}`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  return errors;
};

const validators: Record<SchemaType, Validator> = {
  object: validateObject,
  array: validateArray,
  string: validateString,
  integer: (value, _schema, at) => (Number.isInteger(value) ? [] : [`${at}: expected integer`]),
  boolean: (value, _schema, at) => (typeof value === 'boolean' ? [] : [`${at}: expected boolean`]),
};

function validate(value: unknown, schema: Schema, at = '$'): string[] {
  return validators[schema.type](value, schema, at);
}

// ---- Agent output types ----

export type Verdict = 'added' | 'amended' | 'not-needed' | 'flagged-defect';
export type Kind = 'intent' | 'characterization';
export type Severity = 'blocking' | 'advisory';
export type DefectDecision = 'confirmed' | 'rejected';

export type Expectation = { text: string; source: string };
export type Defect = { test: string; expected: string; received: string; source: string };
export type Unit = {
  path: string;
  unit: string;
  verdict: Verdict;
  reason?: string;
  kind?: Kind;
  expectations: Expectation[];
  tests: string[];
  attempts: number;
  defect?: Defect;
};
export type AuthorOutput = { summary: string; units: Unit[] };

export type Finding = { test: string; severity: Severity; reason: string; note: string };
export type DefectReview = { path: string; unit: string; decision: DefectDecision; source_quote: string };
export type ReviewerOutput = { summary: string; findings: Finding[]; defects: DefectReview[] };
export type Checked = {
  ok: boolean;
  errors: string[];
  dropFiles: string[]; // test files with a blocking finding
  reviewRejected: string[]; // unitKey of units whose tests live in a dropped file (report-only state)
};

// ---- Rules the schema can't express ----

type VerdictRule = {
  requires: readonly (keyof Unit)[]; // fields the schema marks optional but this verdict needs
  writesTests: boolean; // must list at least one test
  needsReview: boolean; // the reviewer must run when any unit has this verdict
};

const verdictRules: Record<Verdict, VerdictRule> = {
  added: { requires: ['kind'], writesTests: true, needsReview: true },
  amended: { requires: ['kind'], writesTests: true, needsReview: true },
  'not-needed': { requires: ['reason'], writesTests: false, needsReview: false },
  'flagged-defect': { requires: ['kind', 'defect'], writesTests: false, needsReview: true },
};

const testFile = (test: string) => test.split(' > ')[0];

export const writesTests = (verdict: Verdict) => verdictRules[verdict].writesTests;

// Unit names repeat across files (`initialize`, `default`), so a unit is identified by path and name together.
export const unitKey = (unit: { path: string; unit: string }) => `${unit.path}#${unit.unit}`;

function checkUnit(unit: Unit, maxAttempts: number): string[] {
  const name = `${unit.path} ${unit.unit}`;
  const rule = verdictRules[unit.verdict];
  const errors = rule.requires.filter((field) => unit[field] === undefined).map((field) => `${name}: ${unit.verdict} needs ${field}`);
  if (rule.writesTests && unit.tests.length === 0) errors.push(`${name}: ${unit.verdict} lists no tests`);
  if (unit.attempts < 0 || unit.attempts > maxAttempts) errors.push(`${name}: attempts ${unit.attempts} outside 0..${maxAttempts}`);
  return errors;
}

function checkDuplicates(units: Unit[]): string[] {
  const keys = units.map(unitKey);
  const repeated = new Set(keys.filter((key, index) => keys.indexOf(key) !== index));
  return [...repeated].map((key) => `unit "${key}" is listed more than once`);
}

function checkFindings(units: Unit[], review: ReviewerOutput): string[] {
  const known = new Set(units.flatMap((u) => u.tests));
  return review.findings.filter((f) => !known.has(f.test)).map((f) => `finding refers to unknown test "${f.test}"`);
}

function checkDefectDecisions(units: Unit[], review: ReviewerOutput): string[] {
  const flagged = new Set(units.filter((u) => u.verdict === 'flagged-defect').map(unitKey));
  const decided = new Set(review.defects.map(unitKey));
  const extra = [...decided].filter((key) => !flagged.has(key)).map((key) => `reviewer decides on "${key}", which is not a flagged-defect`);
  const undecided = [...flagged].filter((key) => !decided.has(key)).map((key) => `flagged-defect "${key}" has no reviewer decision`);
  return [...extra, ...undecided];
}

function blockingFiles(review: ReviewerOutput | undefined): Set<string> {
  const blocking = (review?.findings ?? []).filter((f) => f.severity === 'blocking');
  return new Set(blocking.map((f) => testFile(f.test)));
}

const invalid = (errors: string[]): Checked => ({ ok: false, errors, dropFiles: [], reviewRejected: [] });

function check(author: unknown, reviewer: unknown | undefined, maxAttempts: number): Checked {
  const schemaErrors = [
    ...validate(author, authorSchema).map((e) => `author ${e}`),
    ...(reviewer === undefined ? [] : validate(reviewer, reviewerSchema).map((e) => `reviewer ${e}`)),
  ];
  if (schemaErrors.length) return invalid(schemaErrors);

  const { units } = author as AuthorOutput;
  const review = reviewer as ReviewerOutput | undefined;
  const reviewRequired = units.some((u) => verdictRules[u.verdict].needsReview);

  const errors = [
    ...checkDuplicates(units),
    ...units.flatMap((unit) => checkUnit(unit, maxAttempts)),
    ...(reviewRequired && !review ? ['reviewer.json is missing but the author produced tests or defects'] : []),
    ...(review ? [...checkFindings(units, review), ...checkDefectDecisions(units, review)] : []),
  ];
  if (errors.length) return invalid(errors);

  const dropFiles = blockingFiles(review);
  const reviewRejected = units
    .filter((u) => writesTests(u.verdict) && u.tests.some((t) => dropFiles.has(testFile(t))))
    .map(unitKey);
  return { ok: true, errors: [], dropFiles: [...dropFiles], reviewRejected };
}

// ---- CLI ----

const SCRIPT = 'agent-output';

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
}

function checkFiles(authorFile: string, reviewerFile: string | undefined, maxAttempts: number): Checked {
  try {
    return check(readJson(authorFile), reviewerFile ? readJson(reviewerFile) : undefined, maxAttempts);
  } catch (error) {
    return invalid([(error as Error).message]);
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { reviewer: { type: 'string' }, 'max-attempts': { type: 'string' }, out: { type: 'string' } },
  });
  const [file] = positionals;
  if (!file) die(SCRIPT, 'usage: agent-output.ts <author.json> [--reviewer reviewer.json] [--max-attempts N] [--out checked.json]', 'usage');

  const maxAttempts = Number(values['max-attempts'] ?? process.env.TEST_AGENT_MAX_ATTEMPTS);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) die(SCRIPT, 'pass --max-attempts N or set TEST_AGENT_MAX_ATTEMPTS', 'usage');

  const result = checkFiles(file, values.reviewer, maxAttempts);

  if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n');
  for (const error of result.errors) console.error(`${SCRIPT}: ${error}`);
  const list = (items: string[]) => items.join(', ') || 'none';
  console.log(`${SCRIPT}: ${result.ok ? 'ok' : 'INVALID'}; drop files: ${list(result.dropFiles)}; review-rejected: ${list(result.reviewRejected)}`);
  process.exit(result.ok ? 0 : EXIT_CODES.failed);
}

if (import.meta.main) main();
