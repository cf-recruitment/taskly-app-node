// Minimal GitHub REST helper (Node 24 global fetch, no dependencies).

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const base = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const response = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ''}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} -> ${response.status}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}
