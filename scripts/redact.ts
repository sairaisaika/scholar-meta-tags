/**
 * 抹名：`pnpm redact gh:<id>`——全部断言里该账号的 `by.id` 换成 `redacted:<sha256(id + salt)[:12]>`（同一人仍同一键，裁决不变），
 * `data/actors.jsonl` 删掉该账号的行，`data/REDACTIONS.md` 追加日期与条数（不记登录名）。盐从 `REDACT_SALT` 环境变量来。
 * 如实声明：公开 issue 与 git 历史里的登录名抹不掉——这一步只管 `data/`。
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { EvidenceAnnotation } from 'scholar-meta'
import { REPO_ROOT, listFiles, paths, readJsonl, sha256, writeJsonl } from './lib/store.js'
import type { ActorRow } from './lib/store.js'

export const redactedId = (id: string, salt: string) => `redacted:${sha256(`${id}${salt}`).slice(0, 12)}`

export function redact(id: string, salt: string, root: string = REPO_ROOT, now: Date = new Date()): { replaced: number; files: string[]; actorRowsRemoved: number; to: string } {
  if (!/^gh:\d+$/.test(id)) throw new Error('只接受 gh:<数字 id>')
  if (!salt) throw new Error('需要 REDACT_SALT')
  const p = paths(root)
  const to = redactedId(id, salt)
  let replaced = 0
  const files: string[] = []
  for (const file of listFiles(p.assertions, (n) => n.endsWith('.jsonl'))) {
    const lines = readFileSync(file, 'utf8').split('\n')
    let changed = false
    const out = lines.map((line) => {
      if (!line.trim()) return line
      const a = JSON.parse(line) as EvidenceAnnotation
      if (a.by?.id !== id) return line
      replaced++
      changed = true
      return JSON.stringify({ ...a, by: { ...a.by, id: to } })
    })
    if (changed) { writeFileSync(file, out.join('\n'), 'utf8'); files.push(file) }
  }
  const actors = readJsonl<ActorRow>(p.actors).rows.map((r) => r.value)
  const kept = actors.filter((a) => a.id !== id)
  const actorRowsRemoved = actors.length - kept.length
  if (actorRowsRemoved > 0) writeJsonl(p.actors, kept)
  appendFileSync(p.redactions, `- ${now.toISOString().slice(0, 10)}：${replaced} 条断言、${actorRowsRemoved} 行登录名快照\n`, 'utf8')
  return { replaced, files, actorRowsRemoved, to }
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const id = argv.find((a) => a.startsWith('gh:'))
  if (!id) { console.error('用法：pnpm redact gh:<数字 id>（环境变量 REDACT_SALT）'); return 2 }
  const r = redact(id, env.REDACT_SALT ?? '')
  console.log(`已抹名：${r.replaced} 条断言 → ${r.to}；actors 删 ${r.actorRowsRemoved} 行；改了 ${r.files.length} 个文件。公开 issue 与 git 历史里的登录名抹不掉。`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
