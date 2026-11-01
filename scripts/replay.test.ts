/**
 * 重放：与自己的导出比对一致；改一个分片就报差异；manifest 不比 generated_at / source_commit；互相认可异常检测；差异开 issue（假 GitHub）。
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EvidenceAnnotation } from 'scholar-meta'
import { FORM_ID, validateSubmission } from './lib/intake-core.js'
import type { Actor } from './lib/intake-core.js'
import { appendJsonl, loadConfig, loadVocab, monthFile } from './lib/store.js'
import { W, fakeGitHub, makeTempRepo } from './lib/test-fixtures.js'
import { runExport } from './export.js'
import { REMOTE_ATTEMPTS, comparableManifest, mutualEndorsements, runReplay } from './replay.js'

test('重放：与已发布导出一致 ⇒ 无差异；分片改了 ⇒ 报；manifest 只比内容', async () => {
  const root = makeTempRepo()
  const config = loadConfig(root)
  const vocab = loadVocab(root)
  const actor: Actor = { id: 'gh:1', login: 'u1', tier: 'contributor', type: 'User', created_at: '2020-01-01T00:00:00Z' }
  const r = validateSubmission({ form: FORM_ID, work_id: W, items: [{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }] }, actor, { config, facets: vocab.facets, existing: [], now: new Date('2026-10-31T00:00:00Z'), source: { issue: 1, form: FORM_ID } })
  appendJsonl(join(root, 'data', 'assertions', monthFile('2026-10-31T00:00:00Z').rel), r.accepted)
  const published = runExport({ root, out: 'published', now: new Date('2026-10-01T00:00:00Z'), sourceCommit: 'old', repository: '', maintainers: [] })
  const same = await runReplay({ root, against: 'published', log: () => {} })
  assert.deepEqual(same.diffs, [])
  assert.equal(same.issue, null)
  const shard = published.files.manifest.shards[0]!.path
  writeFileSync(join(published.outDir, shard), readFileSync(join(published.outDir, shard), 'utf8').replace('"ADHD"', '"adhd!"'))
  const gh = fakeGitHub({ issues: [], users: [] })
  const diff = await runReplay({ root, against: 'published', github: gh.gh, log: () => {} })
  assert.deepEqual(diff.diffs.map((d) => d.path), [shard])
  assert.equal(diff.issue, 777)
  const created = gh.log.find((l) => l.op === 'createIssue')!.args as { labels: string[]; body: string }
  assert.deepEqual(created.labels, ['replay'])
  assert.match(created.body, /不一致/)
  assert.equal(comparableManifest(JSON.stringify({ a: 1, generated_at: 'x', source_commit: 'y', repository: 'r1', maintainers: ['m'] })), comparableManifest(JSON.stringify({ a: 1, generated_at: 'z', source_commit: null, repository: '', maintainers: [] })))
  // 远端（Pages）读取用注入的 fetch；manifest 整个拉不到 ⇒ 不比对、不开 issue（没问成 ≠ 不一致）
  const gh2 = fakeGitHub({ issues: [], users: [] })
  const down = await runReplay({ root, pagesUrl: 'https://example.invalid/export/v1', fetch: async () => new Response('', { status: 404 }), github: gh2.gh, log: () => {} })
  assert.deepEqual([down.unreachable, down.diffs, down.issue], [true, [], null])
  assert.ok(!gh2.log.some((l) => l.op === 'createIssue'))
  // manifest 在、某个分片缺 ⇒ 缺文件算差异
  const hits = new Map<string, number>()
  const serve = async (input: RequestInfo | URL) => { const u = String(input); hits.set(u, (hits.get(u) ?? 0) + 1); return u.endsWith('/manifest.json') ? new Response(readFileSync(join(published.outDir, 'manifest.json'), 'utf8'), { status: 200 }) : new Response('', { status: 404 }) }
  const viaFetch = await runReplay({ root, pagesUrl: 'https://example.invalid/export/v1', fetch: serve, sleep: async () => {}, log: () => {} })
  assert.equal(viaFetch.unreachable, false)
  assert.ok(viaFetch.diffs.length > 0 && viaFetch.diffs.every((d) => d.remote === null))
  assert.equal(hits.get(`https://example.invalid/export/v1/${shard}`), REMOTE_ATTEMPTS) // 缺失的文件重试过
  // 第二次才拿到 ⇒ 不算差异（CDN 传播窗口）
  let n = 0
  const flaky = async (input: RequestInfo | URL) => { const u = String(input); const rel = u.slice('https://example.invalid/export/v1/'.length); if (rel === shard && n++ === 0) return new Response('', { status: 404 }); return new Response(readFileSync(join(published.outDir, rel), 'utf8'), { status: 200 }) }
  const healed = await runReplay({ root, pagesUrl: 'https://example.invalid/export/v1', fetch: flaky, sleep: async () => {}, log: () => {} })
  assert.deepEqual(healed.diffs.map((d) => d.path), [shard]) // 之前被改坏的那个分片仍然不一致；别的都一致
})

test('互相认可：两账号互相认可对方 ≥ 5 次且占各自认可 ≥ 80% 才算；每人每对象只算最新一次', () => {
  let n = 0
  const ann = (by: string, work: string, subject: string, kind: 'tag' | 'review', op: 'add' | 'endorse' | 'dispute', at = `2026-10-${String(10 + ++n).padStart(2, '0')}T00:00:00Z`): EvidenceAnnotation =>
    ({ id: `a_${n}`, at, work_id: work, kind, op, subject, by: { kind: 'person', id: by, tier: 'contributor' }, payload: kind === 'tag' ? { kind: 'tag', tag: 'x' } : { kind: 'review', reason: null }, note: null, source: {}, supersedes: null })
  const all: EvidenceAnnotation[] = []
  for (let i = 0; i < 5; i++) {
    all.push(ann('gh:1', `doi:10.1/a${i}`, 'tag:x', 'tag', 'add'), ann('gh:2', `doi:10.1/a${i}`, 'tag:x', 'review', 'endorse'))
    all.push(ann('gh:2', `doi:10.1/b${i}`, 'tag:x', 'tag', 'add'), ann('gh:1', `doi:10.1/b${i}`, 'tag:x', 'review', 'endorse'))
  }
  const pairs = mutualEndorsements(all)
  assert.equal(pairs.length, 1)
  assert.deepEqual([pairs[0]!.a, pairs[0]!.b, pairs[0]!.a_to_b, pairs[0]!.b_to_a, pairs[0]!.a_share], ['gh:1', 'gh:2', 5, 5, 1])
  // gh:1 另外认可了别人 3 次 ⇒ 占比 5/8 < 80% ⇒ 不算
  const diluted = [...all]
  for (let i = 0; i < 3; i++) diluted.push(ann('gh:3', `doi:10.1/c${i}`, 'tag:x', 'tag', 'add'), ann('gh:1', `doi:10.1/c${i}`, 'tag:x', 'review', 'endorse'))
  assert.equal(mutualEndorsements(diluted).length, 0)
  // 改主意成不认可 ⇒ 不再算
  const flipped = [...all, ann('gh:2', 'doi:10.1/a0', 'tag:x', 'review', 'dispute', '2026-12-01T00:00:00Z')]
  assert.equal(mutualEndorsements(flipped).length, 0)
  assert.equal(mutualEndorsements(all, { min: 6 }).length, 0)
})
