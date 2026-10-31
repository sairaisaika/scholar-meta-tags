/**
 * 结构闸：真实仓过；词表的坏情形逐条报；坏 JSONL、邮箱、摘要、坏 by.id 被抓到；导出目录哈希不对被抓到。
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EvidenceConcept } from 'scholar-meta'
import { REPO_ROOT } from './lib/store.js'
import { makeTempRepo } from './lib/test-fixtures.js'
import { checkAnnotation, checkConcepts, checkExport, checkFacets, checkRepo, EMAIL } from './check.js'
import { runExport } from './export.js'

const concept = (id: string, over: Partial<EvidenceConcept> = {}): EvidenceConcept =>
  ({ id, facet: id.slice(2).split('/')[0] as EvidenceConcept['facet'], label: { en: id }, aliases: [], broader: [], status: 'active', replaced_by: null, ...over })

test('真实仓库通过结构闸', () => {
  assert.deepEqual(checkRepo(REPO_ROOT), [])
})

test('词表：id 重复、broader 指向不存在、成环、深度 > 3、deprecated 缺 replaced_by、design 与引擎常量不同', () => {
  const dup = checkConcepts([concept('c:outcome/a'), concept('c:outcome/a')])
  assert.ok(dup.some((p) => p.what === 'duplicate concept id'))
  const missing = checkConcepts([concept('c:outcome/a', { broader: ['c:outcome/zz'] })])
  assert.ok(missing.some((p) => /unknown c:outcome\/zz/.test(p.what)))
  const cycle = checkConcepts([concept('c:outcome/a', { broader: ['c:outcome/b'] }), concept('c:outcome/b', { broader: ['c:outcome/a'] })])
  assert.ok(cycle.some((p) => /cycle/.test(p.what)))
  const deep = checkConcepts([
    concept('c:outcome/a', { broader: ['c:outcome/b'] }), concept('c:outcome/b', { broader: ['c:outcome/c'] }),
    concept('c:outcome/c', { broader: ['c:outcome/d'] }), concept('c:outcome/d', { broader: ['c:outcome/e'] }), concept('c:outcome/e'),
  ])
  assert.ok(deep.some((p) => /deeper than 3/.test(p.what)))
  assert.deepEqual(checkConcepts([concept('c:outcome/a', { broader: ['c:outcome/b'] }), concept('c:outcome/b', { broader: ['c:outcome/c'] }), concept('c:outcome/c', { broader: ['c:outcome/d'] }), concept('c:outcome/d')]), [])
  const dep = checkConcepts([concept('c:outcome/a', { status: 'deprecated', replaced_by: null })])
  assert.ok(dep.some((p) => /replaced_by/.test(p.what)))
  assert.ok(checkConcepts([concept('c:outcome/a', { facet: 'population' })]).some((p) => /does not match facet/.test(p.what)))
  assert.equal(checkFacets({ facets: { design: { values: ['rct'] } } }).length, 1)
})

test('断言：by.id 形状；模型断言要 model_version', () => {
  const base = { id: 'a_0123456789abcdef0123', at: '', work_id: 'doi:10.1/x', kind: 'tag', op: 'add', subject: 'tag:x', payload: { kind: 'tag', tag: 'x' }, note: null, source: {}, supersedes: null } as const
  assert.deepEqual(checkAnnotation({ ...base, by: { kind: 'person', id: 'gh:12', tier: 'contributor' } }, 'f:1'), [])
  assert.deepEqual(checkAnnotation({ ...base, by: { kind: 'person', id: 'redacted:0123456789ab', tier: 'contributor' } }, 'f:1'), [])
  assert.equal(checkAnnotation({ ...base, by: { kind: 'person', id: 'octocat', tier: 'contributor' } }, 'f:1').length, 1)
  assert.equal(checkAnnotation({ ...base, by: { kind: 'model', id: 'smt-vocab-keywords', tier: 'model', model_version: '2026-10' } }, 'f:1').length, 0)
  assert.equal(checkAnnotation({ ...base, by: { kind: 'model', id: 'smt-vocab-keywords', tier: 'model' } }, 'f:1').length, 1)
  assert.equal(checkAnnotation({ ...base, id: 'nope', by: { kind: 'person', id: 'gh:12', tier: 'contributor' } }, 'f:1').length, 1)
})

test('数据文件：坏 JSONL 行、邮箱、名片带摘要都被抓到；导出分片哈希不对被抓到', () => {
  const root = makeTempRepo()
  mkdirSync(join(root, 'data', 'assertions', '2026'), { recursive: true })
  writeFileSync(join(root, 'data', 'assertions', '2026', '10.jsonl'), '{"id":"a_0123456789abcdef0123","work_id":"doi:10.1/x","by":{"kind":"person","id":"gh:1","tier":"contributor"}}\n{not json\n[1,2]\n')
  writeFileSync(join(root, 'data', 'works', '00.jsonl'), JSON.stringify({ work_id: 'doi:10.1/x', aliases: [], card: { title: 'x', abstract: 'leak' }, snapshot_at: '', snapshot_source: 'openalex' }) + '\n')
  writeFileSync(join(root, 'data', 'actors.jsonl'), JSON.stringify({ id: 'gh:1', login: 'someone', seen_at: '', contact: 'someone@example.org' }) + '\n')
  const problems = checkRepo(root)
  const whats = problems.map((p) => p.what)
  assert.ok(whats.some((w) => /unparsable JSONL/.test(w)))
  assert.ok(whats.some((w) => w === 'card.abstract must be null'))
  assert.ok(whats.some((w) => /email/.test(w)))
  assert.ok(problems.every((p) => !p.what.includes('someone@example.org'))) // 不印出完整地址
  assert.ok(EMAIL.test('a.b+c@d-e.org'))
  assert.ok(!EMAIL.test('gh:12345'))

  const clean = makeTempRepo()
  const { outDir } = runExport({ root: clean, now: new Date(), sourceCommit: null, repository: '', maintainers: [] })
  assert.deepEqual(checkExport(outDir), [])
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ contract: '0.1.0', export_version: 1, license: 'CC0-1.0', shards: [{ path: 'works/zz.jsonl', bytes: 1, sha256: 'x', works: 1 }] }))
  const bad = checkExport(outDir)
  assert.ok(bad.some((p) => /missing/.test(p.what)))
  assert.ok(bad.some((p) => p.what === 'contract_mismatch'))
})
