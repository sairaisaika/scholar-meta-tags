/**
 * 质量评估的纯函数部分：断言 + 标准答案（+ 导出里的作品）→ 质量表。算法全部来自引擎 `scoreTagSets` / `scoreLabelAgreement`。
 * 两种对照：
 *   · `models`：每个模型的标签建议对标准答案；
 *   · `consensus`：社区裁决的结果对标准答案——导出里状态为「成立」的标签当作预测；研究设计取裁决出来的值。
 * 标准答案里的作品键可以是任何一个别名：先按导出里的作品换成同一个键再比。
 * 另有 `model_reference`：对模型参考标注（不是人标）的一致程度，与上面两种分开——它不是准确率。
 */
import { scoreLabelAgreement, scoreTagSets } from 'scholar-meta'
import type { EvidenceAnnotation, EvidenceCommunityWork, EvidenceLabelAgreement, EvidenceTagQuality } from 'scholar-meta'
import { currentModelTags } from './export-core.js'
import type { GoldRow, ReferenceRow } from './store.js'

export interface QualityReport {
  gold: { works: number; annotators: number }
  models: Array<{ id: string; versions: string[]; quality: EvidenceTagQuality }>
  /** 社区裁决对标准答案；`works` 是标准答案里、社区已经对至少一个标签有裁决（成立或不成立）的作品数 */
  consensus?: { works: number; tags: EvidenceTagQuality; design: EvidenceLabelAgreement }
  /**
   * 对**模型参考标注**的一致程度——不是准确率。每个参考标注者一节（`by` 是 `model:<id>`）：账本里每个模型的建议与它有多一致。
   * 没有模型参考标注时是空数组。人标的标准答案在上面的 `gold` / `models` / `consensus` 里，两边不混；
   * 这一节的键名也故意不用 gold / tp / fp 之类的字眼，免得被读成对标准答案的成绩。
   */
  model_reference: Array<{ by: string; kind: 'model'; not_human: true; works: number; models: Array<{ id: string; versions: string[]; agreement: ModelAgreement }> }>
}

/** 一个模型的建议与一位模型参考标注者的一致程度。`precision` / `recall` / `f1` 是把参考标注当参考算出来的，量的是一致，不是准确 */
export interface ModelAgreement {
  /** 参考标注了几篇；其中几篇被评模型有建议 */
  works: { reference: number; with_suggestions: number }
  /** （作品, 标签）对：两边都给了的、只有被评模型给了的、只有参考标注者给了的 */
  pairs: { both: number; model_only: number; reference_only: number }
  precision: number | null
  recall: number | null
  f1: number | null
  macro_f1: number | null
  per_tag: Array<{ tag_key: string; label: string; reference_works: number; both: number; model_only: number; reference_only: number; precision: number | null; recall: number | null; f1: number | null }>
}

const agreementOf = (q: EvidenceTagQuality): ModelAgreement => ({
  works: { reference: q.works.gold, with_suggestions: q.works.with_predictions },
  pairs: { both: q.micro.tp, model_only: q.micro.fp, reference_only: q.micro.fn },
  precision: q.micro.precision, recall: q.micro.recall, f1: q.micro.f1, macro_f1: q.macro_f1,
  per_tag: q.per_tag.map((t) => ({ tag_key: t.tag_key, label: t.label, reference_works: t.support, both: t.tp, model_only: t.fp, reference_only: t.fn, precision: t.precision, recall: t.recall, f1: t.f1 })),
})

/** 纯函数：断言 + 标准答案 → 每个模型一份质量（模型按 id 排序；同一模型的各版本合在一起评，版本单列） */
export function evaluateModels(assertions: readonly EvidenceAnnotation[], gold: readonly GoldRow[], canon: (workId: string) => string = (k) => k): QualityReport {
  // 评的是每个模型当前生效的建议（贡献包只算最新版本的那一组），与标注页上显示的是同一份
  const byModel = new Map<string, { versions: Set<string>; works: Map<string, string[]> }>()
  const at = (id: string) => {
    let m = byModel.get(id)
    if (!m) { m = { versions: new Set(), works: new Map() }; byModel.set(id, m) }
    return m
  }
  for (const a of assertions) {
    if (a.by.kind === 'model' && a.kind === 'tag' && a.op === 'add' && a.payload.kind === 'tag' && a.by.model_version) at(a.by.id).versions.add(a.by.model_version)
  }
  for (const [work, models] of currentModelTags(assertions, { canon })) {
    for (const [id, set] of models) at(id).works.set(work, [...set.tags.values()].map((a) => (a.payload.kind === 'tag' ? a.payload.tag : '')))
  }
  const goldSets = gold.map((g) => ({ work_id: canon(g.work_id), tags: g.tags }))
  return {
    gold: { works: gold.length, annotators: new Set(gold.map((g) => g.by)).size },
    models: [...byModel.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, m]) => ({
      id, versions: [...m.versions].sort(),
      quality: scoreTagSets(goldSets, [...m.works.entries()].map(([work_id, tags]) => ({ work_id, tags }))),
    })),
    model_reference: [],
  }
}

/** 每个模型参考标注者一节：把它的标签当「参考」，算账本里各模型的建议与它有多一致（同一套算法，但这不是准确率） */
export function evaluateReference(assertions: readonly EvidenceAnnotation[], reference: readonly ReferenceRow[], canon: (workId: string) => string = (k) => k): QualityReport['model_reference'] {
  const byAnnotator = new Map<string, ReferenceRow[]>()
  for (const r of reference) byAnnotator.set(r.by, [...(byAnnotator.get(r.by) ?? []), r])
  return [...byAnnotator.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([by, rows]) => ({
    by, kind: 'model' as const, not_human: true as const,
    // 同一篇用两个别名各写一行，算一篇
    works: new Set(rows.map((r) => canon(r.work_id))).size,
    // 参考标注者自己若也在账本里提过建议，不拿它和自己比
    models: evaluateModels(assertions, rows.map((r) => ({ work_id: r.work_id, tags: r.tags, by: r.by, at: r.at })), canon).models
      .filter((m) => `model:${m.id}` !== by).map((m) => ({ id: m.id, versions: m.versions, agreement: agreementOf(m.quality) })),
  }))
}

/** 模型 + 社区裁决，两种对照一起算。`works` 是导出里的作品（裁决已经做完的样子） */
export function evaluateQuality(assertions: readonly EvidenceAnnotation[], gold: readonly GoldRow[], works: readonly EvidenceCommunityWork[], reference: readonly ReferenceRow[] = []): QualityReport {
  const alias = new Map<string, string>()
  for (const w of works) { alias.set(w.work_id, w.work_id); for (const a of w.aliases) if (!alias.has(a)) alias.set(a, w.work_id) }
  const canon = (k: string) => alias.get(k) ?? k
  const report = evaluateModels(assertions, gold, canon)
  const goldKeys = new Set(gold.map((g) => canon(g.work_id)))
  // 只把社区已经裁决过标签的作品算作「有预测」：还没人表态的作品不是「社区说它没有标签」
  const decided = works.filter((w) => goldKeys.has(w.work_id) && w.tags.some((t) => t.state === 'present' || t.state === 'absent'))
  const tags = scoreTagSets(
    gold.map((g) => ({ work_id: canon(g.work_id), tags: g.tags })),
    decided.map((w) => ({ work_id: w.work_id, tags: w.tags.filter((t) => t.state === 'present').map((t) => t.tag_key) })),
  )
  const designOf = new Map(works.map((w) => [w.work_id, w.facets.design?.decision.state === 'accepted' || w.facets.design?.decision.state === 'confirmed' ? w.facets.design.value : '']))
  const design = scoreLabelAgreement(gold.filter((g) => typeof g.design === 'string' && g.design).map((g) => ({ gold: g.design as string, predicted: designOf.get(canon(g.work_id)) ?? '' })))
  return { ...report, consensus: { works: decided.length, tags, design }, model_reference: evaluateReference(assertions, reference, canon) }
}
