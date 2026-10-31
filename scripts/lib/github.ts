/**
 * GitHub REST 的最小封装（可注入 fetch，测试不出网）。
 * ─────────────────────────────────────────────────────────────────────────────
 * 只用到：列 issue（分页）、读 issue、列评论、读用户、查仓库权限、加 / 删标签、评论、关闭、开 issue。
 * 失败抛错（调用方决定重试还是标 `retry`）；只有权限查询把 404 当成 `none`（不是协作者）。
 * 不记录任何邮箱：用户对象只取 `id`、`login`、`type`、`created_at`。
 */

export type Permission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'

export interface GhUser { id: number; login: string; type: string; created_at: string | null }
export interface GhLabel { name: string }
export interface GhIssue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  labels: GhLabel[]
  user: { id: number; login: string; type: string }
  created_at: string
  updated_at: string
  pull_request?: unknown
}
export interface GhComment {
  id: number
  body: string | null
  user: { id: number; login: string; type: string }
  created_at: string
}

export interface GitHubOptions {
  token: string
  /** `owner/repo` */
  repo: string
  fetch?: typeof fetch
  baseUrl?: string
  /** 用户代理（GitHub 要求带） */
  userAgent?: string
}

export class GitHubError extends Error {
  constructor(public status: number, public path: string, message: string) { super(`GitHub ${status} ${path}: ${message}`) }
}

export function parseRepo(repo: string): { owner: string; name: string } {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo.trim())
  if (!m) throw new Error(`GH_REPO 要写成 owner/repo，收到：${repo}`)
  return { owner: m[1]!, name: m[2]!, }
}

export function createGitHub(opts: GitHubOptions) {
  const base = (opts.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const f = opts.fetch ?? fetch
  const { owner, name } = parseRepo(opts.repo)
  const repoPath = `/repos/${owner}/${name}`
  const headers = (): Record<string, string> => ({
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${opts.token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': opts.userAgent ?? 'scholar-meta-tags',
  })

  async function request<T>(method: string, path: string, body?: unknown, allow?: number[]): Promise<{ status: number; json: T | null; link: string | null }> {
    const res = await f(`${base}${path}`, {
      method,
      headers: { ...headers(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    if (!res.ok && !(allow ?? []).includes(res.status)) throw new GitHubError(res.status, path, text.slice(0, 300))
    let json: T | null = null
    if (text) { try { json = JSON.parse(text) as T } catch { json = null } }
    return { status: res.status, json, link: res.headers.get('link') }
  }

  /** 分页：跟 `Link: <…>; rel="next"` 走到头 */
  async function paged<T>(path: string): Promise<T[]> {
    const out: T[] = []
    let next: string | null = `${base}${path}${path.includes('?') ? '&' : '?'}per_page=100`
    while (next) {
      const url: string = next
      const res: Response = await f(url, { headers: headers() })
      const text = await res.text()
      if (!res.ok) throw new GitHubError(res.status, url, text.slice(0, 300))
      const page = JSON.parse(text) as T[]
      out.push(...page)
      const link: string | null = res.headers.get('link')
      const m: RegExpExecArray | null = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null
      next = m ? m[1]! : null
      if (page.length === 0) break
    }
    return out
  }

  return {
    owner, name,
    /** 带某标签的 issue（不含 PR）；`state` 缺省 open */
    async listIssues(params: { labels: string; state?: 'open' | 'closed' | 'all' }): Promise<GhIssue[]> {
      const q = `labels=${encodeURIComponent(params.labels)}&state=${params.state ?? 'open'}&sort=created&direction=asc`
      return (await paged<GhIssue>(`${repoPath}/issues?${q}`)).filter((i) => !i.pull_request)
    },
    async getIssue(number: number): Promise<GhIssue | null> {
      const r = await request<GhIssue>('GET', `${repoPath}/issues/${number}`, undefined, [404])
      return r.status === 404 ? null : r.json
    },
    async listComments(number: number): Promise<GhComment[]> {
      return paged<GhComment>(`${repoPath}/issues/${number}/comments`)
    },
    async getUser(login: string): Promise<GhUser | null> {
      const r = await request<GhUser>('GET', `/users/${encodeURIComponent(login)}`, undefined, [404])
      if (r.status === 404 || !r.json) return null
      return { id: r.json.id, login: r.json.login, type: r.json.type, created_at: r.json.created_at ?? null }
    },
    /** 仓库权限；404 ⇒ 不是协作者 ⇒ `none` */
    async getPermission(login: string): Promise<Permission> {
      const r = await request<{ permission?: string; role_name?: string }>('GET', `${repoPath}/collaborators/${encodeURIComponent(login)}/permission`, undefined, [404])
      if (r.status === 404 || !r.json) return 'none'
      const p = (r.json.role_name ?? r.json.permission ?? 'none').toLowerCase()
      return (['admin', 'maintain', 'write', 'triage', 'read'] as const).includes(p as never) ? (p as Permission) : 'none'
    },
    async addLabels(number: number, labels: string[]): Promise<void> {
      if (labels.length === 0) return
      await request('POST', `${repoPath}/issues/${number}/labels`, { labels })
    },
    async removeLabel(number: number, label: string): Promise<void> {
      await request('DELETE', `${repoPath}/issues/${number}/labels/${encodeURIComponent(label)}`, undefined, [404])
    },
    async comment(number: number, body: string): Promise<number | null> {
      const r = await request<{ id: number }>('POST', `${repoPath}/issues/${number}/comments`, { body })
      return r.json?.id ?? null
    },
    async close(number: number, reason: 'completed' | 'not_planned'): Promise<void> {
      await request('PATCH', `${repoPath}/issues/${number}`, { state: 'closed', state_reason: reason })
    },
    async createIssue(input: { title: string; body: string; labels?: string[] }): Promise<number | null> {
      const r = await request<{ number: number }>('POST', `${repoPath}/issues`, input)
      return r.json?.number ?? null
    },
  }
}

export type GitHub = ReturnType<typeof createGitHub>
