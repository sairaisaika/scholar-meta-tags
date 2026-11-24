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
  /** 重试之间的等待（测试里换成不等） */
  sleep?: (ms: number) => Promise<void>
  apiKey?: string | undefined
  baseUrl?: string
  log?: (message: string, detail: Record<string, unknown>) => void
}

/** 一页几条（OpenAlex 上限 200）、一页最多问几次、按年份取名片时最多往回翻几年 */
export const PAGE_SIZE = 200
export const PAGE_ATTEMPTS = 3
export const HARVEST_MAX_YEARS = 60

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
      // 对方的错误说明记进日志（前 200 个字符；是对方写的说明，不含我们的 key）——没问成的原因要查得到
      if (!res.ok) { log('[smt.openalex] non-ok', { status: res.status, detail: (await res.text().catch(() => '')).slice(0, 200) }); return null }
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
     * 按年份列作品：从 `fromYear` 往回，每年取被引最高的一页（最多 200 篇），凑够 `total` 篇为止。
     * 只用「首页列表」这一种请求——匿名可用；游标翻页在匿名时会被拒（2026-11-24 实测：第二页 401）。
     * 某一年问不成会重试；仍不成 ⇒ `complete: false`，已经取到的照样交回——调用方保留它们，并如实报告这次没取完
     * （外部源失败 ≠ 后面没有了）。往回翻满 `HARVEST_MAX_YEARS` 年还不够数 ⇒ 这种取法能取到的就这么多（每年封顶一页，
     * 所以最多 `PAGE_SIZE × HARVEST_MAX_YEARS` 篇；不代表这个过滤条件下只有这么多），`complete: true`。
     */
    async harvestCards(filter: string, total: number, fromYear: number): Promise<{ cards: EvidenceWorkCard[]; complete: boolean; pages: number }> {
      const want = Math.max(0, Math.floor(total))
      const cards: EvidenceWorkCard[] = []
      const seen = new Set<string>()
      let pages = 0
      for (let year = fromYear; cards.length < want && year > fromYear - HARVEST_MAX_YEARS; year--) {
        const url = `${base}/works?filter=${encodeURIComponent(`${filter},publication_year:${year}`)}&sort=cited_by_count:desc&per_page=${PAGE_SIZE}&select=${CARD_SELECT}`
        let json: Record<string, unknown> | null = null
        for (let attempt = 1; attempt <= PAGE_ATTEMPTS && json === null; attempt++) {
          if (attempt > 1) await sleep(2000 * (attempt - 1))
          json = await getJson(url)
        }
        if (json === null) return { cards, complete: false, pages }
        pages++
        for (const raw of json.results as unknown[]) {
          const c = workCardOf(raw)
          if (!c || !c.id || seen.has(c.id) || cards.length >= want) continue
          seen.add(c.id)
          cards.push(publicWorkCard(c))
        }
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
