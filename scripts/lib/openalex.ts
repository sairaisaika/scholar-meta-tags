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
  apiKey?: string | undefined
  baseUrl?: string
  log?: (message: string, detail: Record<string, unknown>) => void
}

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

  return {
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
