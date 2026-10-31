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
import { comparableManifest, mutualEndorsements, runReplay } from './replay.js'

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
  assert.equal(comparableManifest(JSON.stringify({ a: 1, generated_at: 'x', source_commit: 'y' })), comparableManifest(JSON.stringify({ a: 1, generated_at: 'z', source_commit: null })))
  // 远端（Pages）读取用注入的 fetch；缺文件算差异
  const viaFetch = await runReplay({ root, pagesUrl: 'https://example.invalid/export/v1', fetch: async () => new Response('', { status: 404 }), log: () => {} })
  assert.ok(viaFetch.diffs.length > 0 && viaFetch.diffs.every((d) => d.remote === null))
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
