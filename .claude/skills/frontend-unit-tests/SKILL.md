---
name: frontend-unit-tests
description: Conventions and patterns for writing Vitest + React Testing Library unit tests for the React/TypeScript frontend in frontend/src. Use when creating or updating any *.test.ts or *.test.tsx file in frontend/.
---

# Frontend unit tests (React + TanStack Query + RTL + Vitest)

## Layout

- Tests are **colocated**: `Foo.tsx` → `Foo.test.tsx`, `foo.ts` → `foo.test.ts`.
- Environment is jsdom; `src/test/setup.ts` already loads `@testing-library/jest-dom/vitest` and runs `cleanup`.
- Shared data: `src/test/todoFixture.ts` (`todoFixture`). Spread and override it: `{ ...todoFixture, completed: true }`.
- Style: top-level `it(...)`, no semicolons, single quotes, 2-space indent (Prettier). Match neighbouring test files.

## Patterns

**Components**: mock the design system with its ready-made test doubles, then query like a user.

```tsx
vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
const user = userEvent.setup()
render(<TodoItem todo={todoFixture} busy={false} onEdit={onEdit} onToggle={vi.fn()} onDelete={vi.fn()} />)
await user.click(screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }))
expect(onEdit).toHaveBeenCalledTimes(1)
```

Read `src/design-system/mocks.tsx` first to know which roles/test ids the mocks render.

**Containers using hooks** (e.g. `TodosPage`): `vi.mock` each hook module and set return values with `vi.mocked(hook).mockReturnValue({...} as unknown as ReturnType<typeof hook>)`.

**TanStack Query hooks** (`features/todos/hooks/*`): test the real hook with a fresh client per test; mock the API module.

```tsx
vi.mock('../api/todos', () => ({ todosApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() } }))
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })
await act(() => result.current.mutateAsync(input))
expect(queryClient.getQueryData(todoKeys.list)).toEqual([saved])
```

Check the real export names in `api/todos.ts` before mocking.

**HTTP client (`lib/http.ts`)**: `vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })))`, `vi.unstubAllGlobals()` in `afterEach`. Cover network error, aborted signal, 204, 422, error body with/without `detail`.

**Plain hooks / utils**: `renderHook` + `act`, or call pure functions directly with `it.each` tables.

## Query priority

`getByRole` (with `name`) → `getByLabelText` → `getByText` → `getByTestId` (only when the mock exposes one). Use `findBy*` / `waitFor` for async UI, never arbitrary sleeps.

## Don'ts

- No snapshots, no testing of styled-components CSS, no implementation details (state variables, internal callbacks).
- Do not test `src/design-system/**`, `*.stories.tsx`, `*.styles.ts`; they are out of coverage scope.
- No `.only` / `.skip` left behind. Do not edit `vite.config.ts` or `src/test/setup.ts`.
