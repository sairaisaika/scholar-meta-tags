/**
 * OpenAlex（可注入 fetch）：名片走引擎的 `createOpenAlexClient().fetchWorkCard`（三态：found / not_found / error），
 * 冷启动样本的列表请求在这里拼（引擎没有「按过滤器列作品并回名片」的函数），每条仍用引擎的 `workCardOf` 成形。
 * 名片入仓前一律 `publicWorkCard`（摘要置空）；列表请求 `select` 里不要摘要列，省流量。
 */
import { createOpenAlexClient, workCardOf } from 'scholar-meta/openalex'
import type { EvidenceWorkCard, EvidenceWorkRef } from 'scholar-meta'
import { publicWorkCard } from 'scholar-meta'

export interface OpenAlexDeps {
  fetch?: typeof fetch
  /** 翻页重试之间的等待（测试里换成不等） */
  sleep?: (ms: number) => Promise<void>
  apiKey?: string | undefined
  baseUrl?: string
  log?: (message: string, detail: Record<string, unknown>) => void
}

/** 翻页时一页几条（OpenAlex 上限 200）、一页最多问几次 */
export const PAGE_SIZE = 200
export const PAGE_ATTEMPTS = 3

/** 名片要的列（与引擎 `workCardOf` 读的字段一致；不要 `abstract_inverted_index`） */
export const CARD_SELECT = 'id,doi,ids,title,publication_year,type,authorships,primary_location,open_access,topics,keywords,mesh,cited_by_count,language,is_retracted'

export type CardResolution = { kind: 'found'; card: EvidenceWorkCard } | { kind: 'not_found' } | { kind: 'error' }

export function createOpenAlex(deps: OpenAlexDeps = {}) {
  const base = (deps.baseUrl ?? 'https://api.openalex.org').replace(/\/+$/, '')
  const f = deps.fetch ?? fetch
  const log = deps.log ?? (() => {})
  const client = createOpenAlexClient({
    baseUrl: base,
    fetch: f,
    log,
    ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
  })
  const headers = (): Record<string, string> => ({ accept: 'application/json', ...(deps.apiKey ? { authorization: `Bearer ${deps.apiKey}` } : {}) })

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)))
  /** 取一页 JSON；问不成 ⇒ null */
  const getJson = async (url: string): Promise<Record<string, unknown> | null> => {
    try {
      const res = await f(url, { headers: headers() })
      if (!res.ok) { log('[smt.openalex] non-ok', { status: res.status }); return null }
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!json || !Array.isArray(json.results)) { log('[smt.openalex] malformed body', {}); return null }
      return json
    } catch (e) {
      log('[smt.openalex] fetch failed', { error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  return {
    /**
     * 翻页列作品（游标分页，被引从高到低），最多 `total` 篇。每页问不成会重试；仍不成 ⇒ `complete: false`，
     * 已经取到的照样交回——调用方保留它们，并如实报告这次没取完（外部源失败 ≠ 后面没有了）。
     */
    async pageCards(filter: string, total: number): Promise<{ cards: EvidenceWorkCard[]; complete: boolean; pages: number }> {
      const want = Math.max(0, Math.floor(total))
      const cards: EvidenceWorkCard[] = []
      let cursor = '*'
      let pages = 0
      // 页数上限：正常情况下每页都是满的；留出一倍余量给解析不出名片的条目。游标不往前走也当没问成——不无限翻下去
      const maxPages = Math.ceil(want / PAGE_SIZE) * 2 + 2
      while (cards.length < want) {
        if (pages >= maxPages) return { cards, complete: false, pages }
        const url = `${base}/works?filter=${encodeURIComponent(filter)}&sort=cited_by_count:desc&per_page=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}&select=${CARD_SELECT}`
        let json: Record<string, unknown> | null = null
        for (let attempt = 1; attempt <= PAGE_ATTEMPTS && json === null; attempt++) {
          if (attempt > 1) await sleep(2000 * (attempt - 1))
          json = await getJson(url)
        }
        if (json === null) return { cards, complete: false, pages }
        pages++
        const results = json.results as unknown[]
        for (const raw of results) {
          const c = workCardOf(raw)
          if (c && cards.length < want) cards.push(publicWorkCard(c))
        }
        const meta = json.meta as { next_cursor?: unknown } | undefined
        const next = meta && typeof meta.next_cursor === 'string' && meta.next_cursor ? meta.next_cursor : null
        // 没有下一页（或这一页是空的）＝ 真的列完了
        if (!next || results.length === 0) break
        if (next === cursor) return { cards, complete: false, pages }
        cursor = next
      }
      return { cards, complete: true, pages }
    },
    /** 单篇名片（已置空摘要）。`error` ≠ 没有这篇。 */
    async fetchCard(ref: EvidenceWorkRef): Promise<CardResolution> {
      const r = await client.fetchWorkCard(ref)
      if (r.kind === 'found') return { kind: 'found', card: publicWorkCard(r.card) }
      return r
    },
    /**
     * 列作品：`GET /works?filter=<filter>&sort=cited_by_count:desc&per_page=<n>&select=…`。
     * 问不成 ⇒ null（调用方不许把它当「没有」）。
     */
    async listCards(filter: string, perPage: number): Promise<EvidenceWorkCard[] | null> {
      const n = Math.min(Math.max(Math.floor(perPage), 1), 200)
      const url = `${base}/works?filter=${encodeURIComponent(filter)}&sort=cited_by_count:desc&per_page=${n}&select=${CARD_SELECT}`
      try {
        const res = await f(url, { headers: headers() })
        if (!res.ok) { log('[smt.openalex] non-ok', { status: res.status }); return null }
        const json = (await res.json().catch(() => null)) as { results?: unknown } | null
        if (!json || !Array.isArray(json.results)) { log('[smt.openalex] malformed body', {}); return null }
        return json.results.map(workCardOf).filter((c): c is EvidenceWorkCard => c !== null).map(publicWorkCard)
      } catch (e) {
        log('[smt.openalex] fetch failed', { error: e instanceof Error ? e.message : String(e) })
        return null
      }
    },
  }
}

export type OpenAlex = ReturnType<typeof createOpenAlex>
