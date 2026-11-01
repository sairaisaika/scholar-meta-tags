/**
 * 冷启动样本：假 OpenAlex 列表 → 名片（摘要为空）+ 模型层建议断言 + sample.json；无网 ⇒ 不改文件、退出码 0；重跑幂等。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EvidenceAnnotation } from 'scholar-meta'
import { loadAssertions, loadWorks } from './lib/store.js'
import { card, fakeOpenAlex, makeTempRepo } from './lib/test-fixtures.js'
import { createOpenAlex } from './lib/openalex.js'
import { runSample, sampleOf, main } from './sample.js'

test('sampleOf：作品键优先 DOI；摘要置空；主主题一条 + 关键词各一条（≤ 5）；模型断言带 model_version、永不计票的 tier', () => {
  const s = sampleOf({ ...card, keywords: ['a', 'b', 'c', 'd', 'e', 'f'] }, { id: 'openalex:T10537', name: 'ADHD' }, '2026-10-31T00:00:00Z', '2026-10-31')!
  assert.equal(s.snapshot.work_id, 'doi:10.1016/j.jad.2020.01.001')
  assert.deepEqual(s.snapshot.aliases, ['openalex:W3001234567', 'pmid:31900000'])
  assert.equal(s.snapshot.card!.abstract, null)
  assert.equal(s.assertions.length, 6)
  assert.deepEqual(s.assertions[0]!.by, { kind: 'model', id: 'openalex-primary-topic', tier: 'model', model_version: '2026-10-31' })
  assert.equal(s.assertions[0]!.subject, 'tag:attention deficit hyperactivity disorder')
  assert.deepEqual(s.assertions[1]!.source, { sample: 'openalex:T10537', form: 'sample/1' })
  assert.equal(s.assertions[1]!.by.id, 'smt-vocab-keywords')
  assert.equal(sampleOf({ ...card, doi: null }, { id: 'x', name: 'x' }, '', '')!.snapshot.work_id, 'openalex:W3001234567')
  assert.equal(sampleOf({ ...card, doi: null, id: null }, { id: 'x', name: 'x' }, '', ''), null)
})

test('runSample：写名片与断言、更新 sample.json；重跑不重复、不改时间戳；无网不改文件', async () => {
  const root = makeTempRepo()
  const second = { ...card, id: 'openalex:W2', doi: '10.1000/second', pmid: null, title: 'Second', topics: [], keywords: ['Sleep'] }
  const oa = fakeOpenAlex('found', [{ ...card, abstract: 'leak' }, second])
  const r = await runSample({ root, openalex: oa, now: () => new Date('2026-10-31T00:00:00Z'), log: () => {} })
  assert.deepEqual([r.offline, r.works], [false, 2])
  const works = loadWorks(root)
  assert.equal(works.size, 2)
  for (const w of works.values()) assert.equal(w.card!.abstract, null)
  const { assertions } = loadAssertions(root)
  assert.ok(assertions.every((a: EvidenceAnnotation) => a.by.kind === 'model' && a.by.tier === 'model'))
  assert.equal(assertions.length, 1 + 1 + 1) // 第一篇主主题 + 1 关键词；第二篇无主题 + 1 关键词
  const sample = JSON.parse(readFileSync(join(root, 'data', 'sample.json'), 'utf8'))
  assert.deepEqual(sample.topics[0].works, ['doi:10.1016/j.jad.2020.01.001', 'doi:10.1000/second'])
  const again = await runSample({ root, openalex: oa, now: () => new Date('2026-11-01T00:00:00Z'), log: () => {} })
  assert.deepEqual([again.works, again.assertions, again.unchanged], [0, 0, true])
  assert.equal(loadAssertions(root).assertions.length, 3)
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'sample.json'), 'utf8')).generated_at, '2026-10-31T00:00:00.000Z') // 书架没变 ⇒ 不改时间戳
  const logs: string[] = []
  const off = await runSample({ root, openalex: fakeOpenAlex('error', null), log: (s) => logs.push(s) })
  assert.equal(off.offline, true)
  assert.ok(logs.some((l) => /没问成/.test(l)))
  assert.equal(await main(['--root', root], { OPENALEX_API_KEY: undefined }), 0) // 真 fetch 在容器里出不去 ⇒ 也是退出码 0
})

test('OpenAlex 封装：列表请求带 select 不带摘要列；非 2xx / 坏正文 ⇒ null；带 key 时只进 Authorization 头', async () => {
  const seen: Array<{ url: string; auth: string | undefined }> = []
  const f: typeof fetch = async (input, init) => {
    const url = String(input)
    seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization })
    if (url.includes('bad')) return new Response('oops', { status: 500 })
    if (url.includes('weird')) return new Response('{"nope":1}', { status: 200 })
    if (url.includes('/works/doi:')) return new Response(JSON.stringify({ id: 'https://openalex.org/W1', title: 'T', doi: 'https://doi.org/10.1/x', abstract_inverted_index: { leak: [0] } }), { status: 200 })
    return new Response(JSON.stringify({ results: [{ id: 'https://openalex.org/W1', title: 'T', doi: 'https://doi.org/10.1/x', abstract_inverted_index: { leak: [0] } }] }), { status: 200 })
  }
  const oa = createOpenAlex({ fetch: f, apiKey: 'k' })
  const cards = await oa.listCards('primary_topic.id:T1', 3)
  assert.equal(cards!.length, 1)
  assert.equal(cards![0]!.abstract, null)
  assert.ok(seen[0]!.url.includes('select=') && !seen[0]!.url.includes('abstract') && !/api_key|Bearer/.test(seen[0]!.url))
  assert.equal(seen[0]!.auth, 'Bearer k')
  assert.equal(await oa.listCards('bad', 1), null)
  assert.equal(await oa.listCards('weird', 1), null)
  const found = await oa.fetchCard({ kind: 'doi', value: '10.1/x' })
  assert.ok(found.kind === 'found' && found.card.abstract === null)
})
