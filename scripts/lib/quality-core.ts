/**
 * 质量评估的纯函数部分：断言 + 标准答案 → 每个模型一份质量。算法来自引擎 `scoreTagSets`。
 */
import { scoreTagSets } from 'scholar-meta'
import type { EvidenceAnnotation, EvidenceTagQuality } from 'scholar-meta'
import type { GoldRow } from './store.js'

export interface QualityReport {
  gold: { works: number; annotators: number }
  models: Array<{ id: string; versions: string[]; quality: EvidenceTagQuality }>
}

/** 纯函数：断言 + 标准答案 → 每个模型一份质量（模型按 id 排序；同一模型的各版本合在一起评，版本单列） */
export function evaluateModels(assertions: readonly EvidenceAnnotation[], gold: readonly GoldRow[]): QualityReport {
  const byModel = new Map<string, { versions: Set<string>; works: Map<string, string[]> }>()
  for (const a of assertions) {
    if (a.by.kind !== 'model' || a.kind !== 'tag' || a.op !== 'add' || a.payload.kind !== 'tag') continue
    let m = byModel.get(a.by.id)
    if (!m) { m = { versions: new Set(), works: new Map() }; byModel.set(a.by.id, m) }
    if (a.by.model_version) m.versions.add(a.by.model_version)
    const tags = m.works.get(a.work_id) ?? []
    tags.push(a.payload.tag)
    m.works.set(a.work_id, tags)
  }
  const goldSets = gold.map((g) => ({ work_id: g.work_id, tags: g.tags }))
  return {
    gold: { works: gold.length, annotators: new Set(gold.map((g) => g.by)).size },
    models: [...byModel.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, m]) => ({
      id, versions: [...m.versions].sort(),
      quality: scoreTagSets(goldSets, [...m.works.entries()].map(([work_id, tags]) => ({ work_id, tags }))),
    })),
  }
}
