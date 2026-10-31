/**
 * 测试夹具：临时仓根（拷贝真实的 config/ 与 vocab/，空的 data/）、issue 正文渲染、假 GitHub / OpenAlex / git。全部不出网。
 */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvidenceWorkCard } from 'scholar-meta'
import type { GhComment, GhIssue, GhUser, GitHub, Permission } from './github.js'
import type { OpenAlex } from './openalex.js'
import { REPO_ROOT } from './store.js'

export function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'smt-test-'))
  cpSync(join(REPO_ROOT, 'config'), join(root, 'config'), { recursive: true })
  cpSync(join(REPO_ROOT, 'vocab'), join(root, 'vocab'), { recursive: true })
  mkdirSync(join(root, 'data', 'assertions'), { recursive: true })
  mkdirSync(join(root, 'data', 'works'), { recursive: true })
  writeFileSync(join(root, 'data', 'actors.jsonl'), '')
  writeFileSync(join(root, 'data', 'REDACTIONS.md'), '# 抹名记录\n\n')
  writeFileSync(join(root, 'data', 'sample.json'), JSON.stringify({ generated_at: null, topics: [] }))
  return root
}

/** GitHub issue 表单渲染后的正文 */
export function renderIssueBody(payload: unknown, work = 'doi:10.1016/j.jad.2020.01.001', summary = 'ADHD · RCT（Abstract-Methods）'): string {
  return [
    '### 论文 / Work', '', work, '',
    '### 我说了什么（人话，给审阅者看）/ What I\'m saying (plain words)', '', summary, '',
    '### 机器读的部分（请勿手改）/ Machine-readable part (do not edit)', '', '```json', JSON.stringify(payload), '```', '',
    '### 确认 / Confirm', '', '- [x] 我读过这篇论文的相关部分；数字来自原文并写了出处 / I read the relevant parts', '- [x] 我同意以 CC0 1.0 释出这些标注事实 / I release these annotation facts under CC0 1.0', '',
  ].join('\n')
}

export const W = 'doi:10.1016/j.jad.2020.01.001'

export const rowContext = (rowId = 'o1', extra: Record<string, unknown> = {}) => ({
  row_id: rowId, outcome: 'ADHD-RS total score', comparison: 'methylphenidate vs placebo', population: 'adults', timepoint: '8 weeks',
  unit: 'ADHD-RS points', analysis: 'unadjusted', kind: 'continuous', locator: 'Table 2 · row 1', ...extra,
})
/** 区间不含 0 时 p = 0.004，含 0 时 p = 0.4（引擎会核对 p 与区间是否一致） */
export const effect = (value: number, over: Record<string, unknown> = {}) => ({ metric: 'smd', value, ci_low: value - 0.3, ci_high: value + 0.3, n: 212, p_value: Math.abs(value) > 0.3 ? 0.004 : 0.4, higher_is_better: false, ...over })
export const rowItem = (rowId: string, value: number, ctxExtra: Record<string, unknown> = {}) => ({
  kind: 'row', op: 'add', subject: `row:${rowId}`, payload: { kind: 'row', context: rowContext(rowId, ctxExtra), effect: effect(value), direction: null },
})
export const reExtractItem = (rowId: string, value: number, peeked = false) => ({
  kind: 'review', op: 'endorse', subject: `row:${rowId}`, payload: { kind: 'review', reason: null, re_extraction: { effect: effect(value), direction: null }, peeked },
})

export const card: EvidenceWorkCard = {
  id: 'openalex:W3001234567', doi: '10.1016/j.jad.2020.01.001', pmid: '31900000', title: 'Methylphenidate for adult ADHD: a randomised trial', year: 2020,
  authors: ['A. Author', 'B. Author'], venue: { id: 'openalex:S123', name: 'Journal of Affective Disorders', type: 'journal', is_oa: false, issn_l: '0165-0327', publisher: 'Elsevier' },
  publication_type: 'article', topics: [{ id: 'openalex:T10537', display_name: 'Attention Deficit Hyperactivity Disorder' }], keywords: ['Methylphenidate'], mesh: ['Methylphenidate'],
  abstract: 'should never be stored', language: 'en', cited_by_count: 31, is_open_access: false, oa_url: null, is_retracted: false,
}

export interface FakeUser extends GhUser { permission: Permission }

/** 假 GitHub：内存里的 issue / 评论 / 用户；记录每次写操作 */
export function fakeGitHub(input: { issues: GhIssue[]; comments?: Record<number, GhComment[]>; users: FakeUser[] }) {
  const log: Array<{ op: string; issue?: number; args?: unknown }> = []
  const issues = input.issues.map((i) => ({ ...i, labels: [...i.labels] }))
  const comments = new Map<number, GhComment[]>(Object.entries(input.comments ?? {}).map(([k, v]) => [Number(k), [...v]]))
  const gh: GitHub = {
    owner: 'o', name: 'r',
    async listIssues({ labels, state }) { return issues.filter((i) => (state ?? 'open') === 'all' || i.state === (state ?? 'open')).filter((i) => i.labels.some((l) => l.name === labels)) },
    async getIssue(n) { return issues.find((i) => i.number === n) ?? null },
    async listComments(n) { return comments.get(n) ?? [] },
    async getUser(login) { const u = input.users.find((x) => x.login === login); return u ? { id: u.id, login: u.login, type: u.type, created_at: u.created_at } : null },
    async getPermission(login) { return input.users.find((x) => x.login === login)?.permission ?? 'none' },
    async addLabels(n, labels) { log.push({ op: 'addLabels', issue: n, args: labels }); const i = issues.find((x) => x.number === n); if (i) for (const l of labels) if (!i.labels.some((x) => x.name === l)) i.labels.push({ name: l }) },
    async removeLabel(n, label) { log.push({ op: 'removeLabel', issue: n, args: label }); const i = issues.find((x) => x.number === n); if (i) i.labels = i.labels.filter((x) => x.name !== label) },
    async comment(n, body) { log.push({ op: 'comment', issue: n, args: body }); return 9000 + log.length },
    async close(n, reason) { log.push({ op: 'close', issue: n, args: reason }); const i = issues.find((x) => x.number === n); if (i) i.state = 'closed' },
    async createIssue(i) { log.push({ op: 'createIssue', args: i }); return 777 },
  }
  return { gh, log, issues }
}

export const user = (id: number, login: string, permission: Permission = 'none', ageDays = 400): FakeUser =>
  ({ id, login, type: 'User', created_at: new Date(Date.now() - ageDays * 86_400_000).toISOString(), permission })

export const issue = (number: number, login: string, id: number, body: string, labels: string[] = ['annotation']): GhIssue =>
  ({ number, title: '[annotate]', body, state: 'open', labels: labels.map((name) => ({ name })), user: { id, login, type: 'User' }, created_at: '2026-10-31T00:00:00Z', updated_at: '2026-10-31T00:00:00Z' })

export const comment = (id: number, login: string, uid: number, body: string): GhComment => ({ id, body, user: { id: uid, login, type: 'User' }, created_at: '2026-10-31T01:00:00Z' })

export function fakeOpenAlex(mode: 'found' | 'not_found' | 'error' = 'found', list: EvidenceWorkCard[] | null = null): OpenAlex {
  return {
    async fetchCard() { return mode === 'found' ? { kind: 'found', card: { ...card, abstract: null } } : { kind: mode } },
    async listCards() { return list },
  }
}

/** 假 git：记录命令；`diff --cached` 回非空让 commit 走下去；`push` 可按次数失败 */
export function fakeGit(failPushes = 0) {
  const calls: string[][] = []
  let pushes = 0
  const git = (args: string[]) => {
    calls.push(args)
    if (args[0] === 'diff') return 'data/x\n'
    if (args[0] === 'push' && pushes++ < failPushes) throw new Error('rejected')
    return ''
  }
  return { git, calls }
}
