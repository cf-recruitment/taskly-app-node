---
name: backend-unit-tests
description: Conventions and patterns for writing Vitest unit tests for the Express + Prisma backend in backend/. Use when creating or updating any test under backend/tests/.
---

# Backend unit tests (Express + Prisma + Vitest)

## Layout

- Tests live in `backend/tests/<source-basename>.test.ts` (flat directory), e.g. `src/features/todos/router.ts` → `tests/router.test.ts`.
- Import sources with the **`.ts` extension**: `import { createApp } from '../src/factory.ts'`.
- Shared data: `tests/fixture.ts` exports `record` (Prisma row) and `todo` (API shape). Reuse them; extend the fixture only if a new field is needed by several tests.
- Style: top-level `it(...)` (no `describe` nesting), a local `setup()` function returning what the test needs, `it.each` for input tables. Match the existing files in `backend/tests/`.

## Patterns

**HTTP layer (routers, `createApp`)**: use `supertest` against a real Express app, never a listening port.

```ts
import request from 'supertest';
const repository = { list: vi.fn(), create: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn() };
const app = express(); app.use(express.json()); app.use('/api/todos', createTodosRouter(repository));
expect((await request(app).get('/api/todos/1')).status).toBe(404);
```

For `createApp(database)` pass a fake `Database` object containing only what the code under test calls (e.g. `{ todo: { findFirst: vi.fn(), findMany: vi.fn() } }`); cast with `as unknown as Database`.

**Prisma / repository**: construct the real client without connecting and spy on delegate methods (no PostgreSQL needed):

```ts
const database = createDatabase('postgresql://test:test@localhost:5432/test');
vi.spyOn(database.todo, 'findMany').mockResolvedValue([record]);
```

**Environment / config**: use `vi.stubEnv(...)` and `vi.unstubAllEnvs()` in `afterEach`. Never read the real `.env`.

**Process-level code (`lifespan.ts`, `main.ts`)**: mock collaborators with `vi.mock('../src/core/database.ts', ...)`, call `start()` with `API_PORT=0`, close the returned server in the test. Spy on `process.once` instead of sending real signals.

## What to assert

- Status code **and** response body for each branch: success, 404, 422 (validation), 413/422 (body parser errors), 500.
- That the repository is **not** called when validation fails.
- Arguments passed to Prisma (query shape) and the mapping back to API shape.
- Error propagation (`mockRejectedValue`) → expected status / thrown error.

## Don'ts

- No real network, database, timers or filesystem writes. Use `vi.useFakeTimers()` if time matters.
- No snapshot tests, no `test.only`, no `.skip` left in code.
- Do not lower coverage thresholds in `vitest.config.ts`; that file is not yours to edit.
- Silence expected `console.error` with `vi.spyOn(console, 'error').mockImplementation(() => {})` and assert it was called.
