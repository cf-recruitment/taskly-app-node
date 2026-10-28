// Minimal GitHub REST client (Node 24 global fetch, no dependencies).

export type GitHubOptions = { token: string; baseUrl?: string };
export type RequestOptions = { method?: string; body?: unknown };
export type GitHub = {
  request<T>(path: string, init?: RequestOptions): Promise<T>;
  // All items of a list endpoint, at most maxPages pages of 100.
  paginate<T>(path: string, maxPages: number): Promise<T[]>;
};

const DEFAULT_BASE_URL = 'https://api.github.com';
const PAGE_SIZE = 100;
const MAX_ERROR_BODY = 500;

export function github({ token, baseUrl = DEFAULT_BASE_URL }: GitHubOptions): GitHub {
  if (!token) throw new Error('GitHub token is empty');

  async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, MAX_ERROR_BODY);
      throw new Error(`GitHub API ${method} ${path} -> ${response.status}: ${body}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  async function paginate<T>(path: string, maxPages: number): Promise<T[]> {
    const items: T[] = [];
    const separator = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page++) {
      const batch = await request<T[]>(`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`);
      items.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return items;
  }

  return { request, paginate };
}
