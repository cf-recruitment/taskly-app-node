---
name: run-unit-tests
description: Runs backend or frontend Vitest suites (targeted files or full suite with coverage) and returns compact JSON with pass/fail details and coverage. Use to verify every test you create or change, and for the final full-suite check before reporting.
---

# Run unit tests

```bash
# Fast loop: only the given test files, no coverage
node .claude/skills/run-unit-tests/scripts/run-tests.mjs frontend frontend/src/lib/http.test.ts
# Final check: whole project with coverage + thresholds
node .claude/skills/run-unit-tests/scripts/run-tests.mjs backend
```

Paths are relative to the repository root. Output (stdout, exit 0 = all green):

```json
{ "project": "backend", "scope": "full-suite", "ok": true, "exitCode": 0,
  "tests": { "total": 52, "passed": 52, "failed": 0 },
  "failures": [ { "file": "tests/x.test.ts", "test": "name", "message": "..." } ],
  "coverage": { "statements": 81.2, "branches": 75, "functions": 90, "lines": 82.4 },
  "log": "present only when it failed without failed tests (threshold, crash, timeout)" }
```

## Verification loop

1. After writing or editing a test file, run it **targeted**.
2. On failure, read the message and decide:
   - **The test is wrong** (bad query, wrong mock, wrong expectation about existing behaviour) → fix the test and rerun.
   - **The source is wrong** (the test encodes the documented/obvious intent and the code violates it) → do **not** change source and do **not** weaken the assertion to make it pass. Remove that one case, keep the rest, and report the suspected bug with the assertion that failed.
3. At most **3 fix attempts per file**. After that, revert your changes to that file (`git checkout -- <file>`, or `rm <file>` if you created it) and report it as "could not stabilise".
4. When all targeted runs pass, run the **full suite** for each project you touched. It must pass, including coverage thresholds. Record the coverage numbers for the report.

Never report a test as passing unless this script returned `"ok": true` for it in this session.
