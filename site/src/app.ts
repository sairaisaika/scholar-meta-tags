/**
 * 页面共享的上下文：语言、词典、导出状态、本会话里从 OpenAlex 取到的名片（只在内存）、导航。
 * OpenAlex 客户端按需建：只有用户点「向 OpenAlex 查询 / 搜候选」时才会发请求（不带 key）。
 */
import type { EvidenceMessageCatalog, EvidenceWorkCard } from 'scholar-meta'
import { createOpenAlexClient, type OpenAlexClient } from 'scholar-meta/openalex'
import { config, type ExportState, type Loaded } from './data.js'
import type { Locale, Strings } from './i18n.js'

export interface App {
  locale: Locale
  t: Strings
  m: EvidenceMessageCatalog
  exportState: ExportState
  data: Loaded | null
  /** 作品键 → 本会话里从 OpenAlex 取到的名片（含摘要，只显示不存） */
  cards: Map<string, EvidenceWorkCard>
  navigate(hash: string): void
  rerender(): void
}

let client: OpenAlexClient | null = null
export function openalex(): OpenAlexClient {
  if (!client) client = createOpenAlexClient({ baseUrl: config.openalex.baseUrl, log: () => { /* 页面不往控制台倒错误：失败已在界面上说明 */ } })
  return client
}

export const routeWork = (key: string) => `#/w/${encodeURIComponent(key)}`
export const routeTag = (key: string) => `#/t/${encodeURIComponent(key)}`
