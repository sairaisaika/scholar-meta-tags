/**
 * 重放：全部断言从头重跑导出到临时目录，与 Pages 上的（或 `--against <dir>`）逐文件比对 sha256；
 * `manifest.json` 只比 `generated_at` / `source_commit` / `repository` / `maintainers` 以外的部分（前两项每次不同，后两项取自运行环境），`queues.json` 不比按时刻算的 `stale_pending`。不一致 ⇒ 用 GitHub API 开 issue（标签 `replay`）。
 * 另算「互相认可比例异常」：两账号互相 endorse 对方提出的 subject ≥ 5 次，且各占自己全部认可的 ≥ 80%，写进输出（`replay.json` 与 issue）。
 * 用法：`pnpm replay [--against <dir>] [--pages <url>] [--root <dir>] [--no-issue]`；环境 `GH_TOKEN`、`GH_REPO`。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EvidenceAnnotation } from 'scholar-meta'
import { createGitHub } from './lib/github.js'
import type { GitHub } from './lib/github.js'
import { REPO_ROOT, listFiles, loadAssertions, sha256 } from './lib/store.js'
import { argValue, runExport } from './export.js'

export interface FileDiff { path: string; local: string | null; remote: string | null }

/** manifest 去掉与内容无关、每次或每个环境都可能不同的几项再比：生成时间、提交、仓库地址与维护者名单（后两项来自运行环境） */
export function comparableManifest(text: string): string {
  const m = JSON.parse(text) as Record<string, unknown>
  delete m.generated_at
  delete m.source_commit
  delete m.repository
  delete m.maintainers
  return JSON.stringify(m)
}

/** 按文件决定比什么：manifest 去掉时间与提交；queues 去掉按时刻算的 stale_pending；其余逐字节 */
export function comparable(path: string, text: string): string {
  if (path === 'manifest.json') return comparableManifest(text)
  if (path === 'queues.json') { const q = JSON.parse(text) as Record<string, unknown>; delete q.stale_pending; return JSON.stringify(q) }
  return text
}

/** 本地导出目录 vs 远端读取函数（远端缺的文件 remote 为 null） */
export async function diffExports(localDir: string, remote: (path: string) => Promise<string | null>): Promise<FileDiff[]> {
  const diffs: FileDiff[] = []
  const files = listFiles(localDir).map((f) => f.slice(localDir.length + 1))
  for (const path of files) {
    const localText = readFileSync(join(localDir, path), 'utf8')
    const remoteText = await remote(path)
    const norm = (t: string | null) => (t === null ? null : sha256(comparable(path, t)))
    const a = norm(localText)
    const b = norm(remoteText)
    if (a !== b) diffs.push({ path, local: a, remote: b })
  }
  return diffs
}

export interface MutualPair { a: string; b: string; a_to_b: number; b_to_a: number; a_share: number; b_share: number }

/** 互相认可：A 对 B 提出的 subject 的 endorse 次数（每人每 subject 只算最新一次） */
export function mutualEndorsements(assertions: readonly EvidenceAnnotation[], opts: { min?: number; share?: number } = {}): MutualPair[] {
  const min = opts.min ?? 5
  const share = opts.share ?? 0.8
  const proposer = new Map<string, string>() // work\0subject → 最新 add 的 by.id
  const sorted = [...assertions].sort((x, y) => (x.at < y.at ? -1 : 1))
  for (const a of sorted) if (a.op === 'add' && a.kind !== 'review' && a.by.kind === 'person') proposer.set(`${a.work_id}\u0000${a.subject}`, a.by.id)
  const latest = new Map<string, EvidenceAnnotation>()
  for (const a of sorted) if (a.kind === 'review' && a.by.kind === 'person') latest.set(`${a.by.id}\u0000${a.work_id}\u0000${a.subject}`, a)
  const counts = new Map<string, Map<string, number>>() // from → to → n
  const totals = new Map<string, number>()
  for (const a of latest.values()) {
    if (a.op !== 'endorse') continue
    const to = proposer.get(`${a.work_id}\u0000${a.subject}`)
    if (!to || to === a.by.id) continue
    const row = counts.get(a.by.id) ?? new Map<string, number>()
    row.set(to, (row.get(to) ?? 0) + 1)
    counts.set(a.by.id, row)
    totals.set(a.by.id, (totals.get(a.by.id) ?? 0) + 1)
  }
  const out: MutualPair[] = []
  for (const [a, row] of counts) {
    for (const [b, ab] of row) {
      if (a >= b) continue
      const ba = counts.get(b)?.get(a) ?? 0
      const aShare = ab / (totals.get(a) ?? 1)
      const bShare = ba / (totals.get(b) ?? 1)
      if (ab >= min && ba >= min && aShare >= share && bShare >= share) out.push({ a, b, a_to_b: ab, b_to_a: ba, a_share: aShare, b_share: bShare })
    }
  }
  return out.sort((x, y) => y.a_to_b + y.b_to_a - (x.a_to_b + x.b_to_a))
}

export interface ReplayDeps {
  root?: string
  against?: string
  pagesUrl?: string | null
  fetch?: typeof fetch
  github?: GitHub | null
  log?: (s: string) => void
}

export async function runReplay(deps: ReplayDeps = {}): Promise<{ diffs: FileDiff[]; mutual: MutualPair[]; issue: number | null; outDir: string }> {
  const root = deps.root ?? REPO_ROOT
  const log = deps.log ?? ((s: string) => console.log(s))
  const outDir = mkdtempSync(join(tmpdir(), 'smt-replay-'))
  const { files, issues } = runExport({ root, out: outDir, sourceCommit: null })
  if (issues.length > 0) throw new Error(`重放导出读回有问题：${issues.map((i) => `${i.code}@${i.path}`).join(', ')}`)
  let remote: ((path: string) => Promise<string | null>) | null = null
  if (deps.against) {
    const dir = resolve(root, deps.against)
    remote = async (path) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : null)
  } else if (deps.pagesUrl) {
    const base = deps.pagesUrl.replace(/\/+$/, '')
    const f = deps.fetch ?? fetch
    remote = async (path) => { try { const r = await f(`${base}/${path}`); return r.ok ? await r.text() : null } catch { return null } }
  }
  const diffs = remote ? await diffExports(outDir, remote) : []
  const mutual = mutualEndorsements(loadAssertions(root).assertions)
  const report = { replayed_at: new Date().toISOString(), works: files.manifest.counts.works, diffs, mutual_endorsements: mutual }
  writeFileSync(join(outDir, 'replay.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  log(JSON.stringify(report, null, 2))
  let issue: number | null = null
  if (deps.github && (diffs.length > 0 || mutual.length > 0)) {
    const body = [
      diffs.length > 0 ? `## 重放与已发布导出不一致 / Replay differs from the published export\n\n${diffs.map((d) => `- \`${d.path}\`：local ${d.local ?? '—'} · published ${d.remote ?? '—'}`).join('\n')}` : '',
      mutual.length > 0 ? `## 互相认可比例异常 / Mutual endorsement anomaly\n\n${mutual.map((m) => `- \`${m.a}\` ⇄ \`${m.b}\`：${m.a_to_b} / ${m.b_to_a}（${(m.a_share * 100).toFixed(0)}% / ${(m.b_share * 100).toFixed(0)}%）`).join('\n')}` : '',
      '_由 replay 工作流生成 / generated by the replay workflow_',
    ].filter(Boolean).join('\n\n')
    issue = await deps.github.createIssue({ title: `replay: ${diffs.length} file(s) differ, ${mutual.length} mutual pair(s)`, body, labels: ['replay'] })
  }
  return { diffs, mutual, issue, outDir }
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const repo = env.GH_REPO ?? env.GITHUB_REPOSITORY ?? null
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN ?? null
  const against = argValue(argv, '--against')
  const pages = argValue(argv, '--pages') ?? (repo ? `https://${repo.split('/')[0]}.github.io/${repo.split('/')[1]}/export/v1` : null)
  const github = argv.includes('--no-issue') || !repo || !token ? null : createGitHub({ token, repo })
  const r = await runReplay({ ...(against ? { against } : {}), pagesUrl: against ? null : pages, github })
  if (r.diffs.length > 0) { console.error(`❌ ${r.diffs.length} 个文件与已发布导出不一致${r.issue ? `（已开 issue #${r.issue}）` : ''}`); return 1 }
  console.log(`✅ 重放一致；互相认可异常 ${r.mutual.length} 对`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
