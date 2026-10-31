/**
 * 导出：读全部断言与名片 → `buildExport` → 写 `export/v1/*` → 用引擎 `readCommunityExport` 读回自检（issues 非空即失败）。
 * 用法：`pnpm export [--out export/v1] [--maintainers a,b] [--root <dir>]`
 * 维护者登录名：`--maintainers`，否则环境变量 `SMT_MAINTAINERS`（逗号分隔），否则 `config/roles.json` 里 maintainer 的登录名（经 actors.jsonl 反查）。
 * 派生导出不提交回 main（export/ 已 gitignore）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readCommunityExport } from 'scholar-meta'
import { buildExport, serializeShard } from './lib/export-core.js'
import type { ExportFiles } from './lib/export-core.js'
import { REPO_ROOT, loadActors, loadAssertions, loadBlocklist, loadConfig, loadRoles, loadVocab, loadWorks, policyOf } from './lib/store.js'

export interface ExportOptions {
  root?: string
  out?: string
  maintainers?: string[]
  repository?: string
  now?: Date
  sourceCommit?: string | null
  log?: (s: string) => void
}

export function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function gitHead(root: string): string | null {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null } catch { return null }
}

/** 维护者登录名：参数 > 环境变量 > roles.json（maintainer）经 actors.jsonl 反查 */
export function maintainerLogins(root: string, explicit: string[] | undefined, env: NodeJS.ProcessEnv): string[] {
  if (explicit && explicit.length > 0) return explicit
  const fromEnv = (env.SMT_MAINTAINERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (fromEnv.length > 0) return fromEnv
  const actors = loadActors(root)
  return Object.entries(loadRoles(root)).filter(([, r]) => r === 'maintainer').map(([id]) => actors.get(id)?.login).filter((s): s is string => !!s)
}

/** 读仓库、算导出、写文件；回写出的文件清单与自检问题 */
export function runExport(opts: ExportOptions = {}): { files: ExportFiles; outDir: string; issues: Array<{ code: string; path: string }> } {
  const root = opts.root ?? REPO_ROOT
  const outDir = resolve(root, opts.out ?? 'export/v1')
  const config = loadConfig(root)
  const vocab = loadVocab(root)
  const { assertions, bad } = loadAssertions(root)
  if (bad.length > 0) throw new Error(`断言文件有坏行：${bad.map((b) => `${b.file}:${b.line}`).join(', ')}`)
  const files = buildExport({
    assertions,
    works: loadWorks(root),
    policy: policyOf(config),
    blocklist: loadBlocklist(root),
    facets: vocab.facets,
    concepts: vocab.concepts,
    vocabBindings: vocab.bindings,
    label: config.export.label,
    repository: opts.repository ?? (process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : ''),
    maintainers: maintainerLogins(root, opts.maintainers, process.env),
    generated_at: (opts.now ?? new Date()).toISOString(),
    source_commit: opts.sourceCommit === undefined ? gitHead(root) : opts.sourceCommit,
    stale_days: config.queue.stale_days,
  })
  writeExport(outDir, files)
  const issues = selfCheck(files)
  return { files, outDir, issues }
}

export function writeExport(outDir: string, files: ExportFiles): void {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(join(outDir, 'works'), { recursive: true })
  for (const [path, works] of files.shards) writeFileSync(join(outDir, path), serializeShard(works), 'utf8')
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(files.manifest, null, 2)}\n`, 'utf8')
  writeFileSync(join(outDir, 'frames.json'), `${JSON.stringify(files.frames)}\n`, 'utf8')
  writeFileSync(join(outDir, 'bindings.json'), `${JSON.stringify(files.bindings)}\n`, 'utf8')
  writeFileSync(join(outDir, 'concepts.json'), `${JSON.stringify(files.concepts)}\n`, 'utf8')
  writeFileSync(join(outDir, 'queues.json'), `${JSON.stringify(files.queues, null, 2)}\n`, 'utf8')
}

/** 用写出的内容（重新解析字节）走引擎读回：契约、形状、摘要都由引擎说了算 */
export function selfCheck(files: ExportFiles): Array<{ code: string; path: string }> {
  const shards = [...files.shards.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, works]) => serializeShard(works).split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown))
  const r = readCommunityExport(JSON.parse(JSON.stringify(files.manifest)), shards, {
    bindings: JSON.parse(JSON.stringify(files.bindings)), concepts: JSON.parse(JSON.stringify(files.concepts)), frames: JSON.parse(JSON.stringify(files.frames)),
  })
  if (!r.ok) return r.issues
  const issues: Array<{ code: string; path: string }> = [...r.issues]
  if (r.value.works.length !== files.manifest.counts.works) issues.push({ code: 'count_mismatch', path: 'manifest.counts.works' })
  return issues
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const maint = argValue(argv, '--maintainers')
  const { files, outDir, issues } = runExport({
    ...(argValue(argv, '--root') ? { root: resolve(argValue(argv, '--root')!) } : {}),
    ...(argValue(argv, '--out') ? { out: argValue(argv, '--out')! } : {}),
    ...(maint ? { maintainers: maint.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  })
  const c = files.manifest.counts
  console.log(`导出到 ${outDir}：${c.works} 篇作品 · ${c.assertions} 条断言 · ${c.contributors} 位贡献者 · accepted ${c.accepted} · pending ${c.pending} · disputed ${c.disputed} · ${c.frames} 个 frame · ${files.manifest.shards.length} 个分片`)
  if (issues.length > 0) {
    console.error(`读回自检有 ${issues.length} 个问题：`)
    for (const i of issues) console.error(`  - ${i.code} @ ${i.path}`)
    return 1
  }
  console.log('读回自检：零问题')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
