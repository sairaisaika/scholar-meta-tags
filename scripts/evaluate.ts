/**
 * 质量评估：把每个模型的标签建议、以及社区裁决的结果，与维护者标的标准答案（`data/gold/*.jsonl`）对照；算法全部来自引擎
 * `scoreTagSets`（标签）与 `scoreLabelAgreement`（研究设计）。
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 只评标准答案覆盖到的作品；标准答案里写空数组表示「这篇确实没有这些标签」。
 *   · 没有标准答案时如实说没有——指标是 null，不是 0。
 *   · 结果随导出写成 `quality.json`（不在引擎契约里，宿主的读取函数不看它），所以每周的重放也会核到它。
 *   · `data/model-reference/*.jsonl` 是模型参考标注（不是人标）：单独一节输出，写明是两个模型的一致程度、不是准确率；`quality.json` 里在 `model_reference`。
 * 这些数只说明「与这份标准答案有多一致」；标准答案由谁标、够不够有代表性，写在 `data/gold/README.md`。
 * 用法：`pnpm evaluate [--root <dir>] [--lang zh|en]`
 */
import { pathToFileURL } from 'node:url'
import { presentLabelAgreement, presentTagQuality } from 'scholar-meta'
import { REPO_ROOT, loadAssertions, loadBlocklist, loadConfig, loadGold, loadReference, loadVocab, loadWorks, policyOf } from './lib/store.js'
import { buildExport } from './lib/export-core.js'
import { evaluateModels, evaluateQuality } from './lib/quality-core.js'
import type { QualityReport } from './lib/quality-core.js'
import { argValue } from './export.js'

export { evaluateModels, evaluateQuality }
export type { QualityReport }

/** 与导出写进 `quality.json` 的是同一份：裁决结果取自同一次 `buildExport` */
export function qualityOf(root: string = REPO_ROOT): QualityReport {
  const config = loadConfig(root)
  const vocab = loadVocab(root)
  const { assertions } = loadAssertions(root)
  const works = buildExport({
    assertions, works: loadWorks(root), policy: policyOf(config), blocklist: loadBlocklist(root), facets: vocab.facets, concepts: vocab.concepts, vocabBindings: vocab.bindings,
    label: config.export.label, repository: '', maintainers: [], generated_at: new Date(0).toISOString(), source_commit: null, stale_days: config.queue.stale_days,
  }).export.works
  return evaluateQuality(assertions, loadGold(root).rows, works, loadReference(root).rows)
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const root = argValue(argv, '--root') ?? REPO_ROOT
  const locale = argValue(argv, '--lang') === 'en' ? 'en' : 'zh'
  const report = qualityOf(root)
  console.log(locale === 'zh' ? `标准答案：${report.gold.works} 篇，${report.gold.annotators} 位标注人` : `Reference labels: ${report.gold.works} works by ${report.gold.annotators} annotator(s)`)
  for (const m of report.models) {
    const v = presentTagQuality(m.quality, { locale })
    console.log(`\n${m.id}${m.versions.length ? ` @ ${m.versions.join(', ')}` : ''}`)
    if (v.none_text) { console.log(`  ${v.none_text}`); continue }
    for (const line of [v.summary_text, v.coverage_text, v.macro_text]) if (line) console.log(`  ${line}`)
    for (const t of v.tags.slice(0, 10)) console.log(`    ${t.text}`)
    if (v.tags.length > 10) console.log(`    … +${v.tags.length - 10}`)
  }
  if (report.models.length === 0) console.log(locale === 'zh' ? '账本里还没有模型建议。' : 'No model suggestions in the ledger yet.')
  if (report.consensus) {
    const c = report.consensus
    console.log(locale === 'zh' ? `\n社区裁决对标准答案（标准答案里已有标签裁决的作品 ${c.works} 篇）` : `\nCommunity decisions vs reference labels (${c.works} reference works with a tag decision)`)
    const v = presentTagQuality(c.tags, { locale })
    if (v.none_text) console.log(`  ${v.none_text}`)
    else if (c.tags.works.with_predictions === 0) console.log(locale === 'zh' ? '  标准答案里的作品，社区还没有裁决出任何标签。' : '  No community tag decision yet on any reference work.')
    else for (const line of [v.summary_text, v.coverage_text, v.macro_text]) if (line) console.log(`  ${line}`)
    const d = presentLabelAgreement(c.design, { locale })
    console.log(`  ${locale === 'zh' ? '研究设计' : 'Study design'}：${d.agreement_text ?? (locale === 'zh' ? '没有可比的作品（标准答案没写设计，或社区还没裁决）' : 'nothing to compare yet')}${d.kappa_text ? ` · ${d.kappa_text}` : ''}`)
  }
  // 模型参考标注：单独一节，开头就写明不是人标的、不是准确率。句子在这里自己写，不借引擎那几句「标准答案 / correct / missed」
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 1000) / 10}%`)
  for (const ref of report.model_reference) {
    console.log(locale === 'zh'
      ? `\n模型参考标注（不是人标的；标注者 ${ref.by}，${ref.works} 篇）——下面的数只说明两个模型有多一致，不是准确率`
      : `\nModel comparison labels (NOT human-labelled; annotator ${ref.by}, ${ref.works} works) — the figures below are agreement between two models, not accuracy`)
    for (const m of ref.models) {
      const a = m.agreement
      console.log(`  ${m.id}${m.versions.length ? ` @ ${m.versions.join(', ')}` : ''}`)
      // 这个模型只在少数几篇上有建议（比如只给打样书架打过）：算出来的比例没有意义，只说覆盖了几篇
      if (a.works.with_suggestions * 5 < a.works.reference) {
        console.log(locale === 'zh'
          ? `    参考标注 ${a.works.reference} 篇里，这个模型只在 ${a.works.with_suggestions} 篇上有建议——太少，不算比例`
          : `    this model has suggestions on only ${a.works.with_suggestions} of the ${a.works.reference} works with comparison labels — too few to compute rates`)
        continue
      }
      console.log(locale === 'zh'
        ? `    两边都给了 ${a.pairs.both} 对 · 只有这个模型给了 ${a.pairs.model_only} · 只有参考标注者给了 ${a.pairs.reference_only}`
        : `    ${a.pairs.both} pairs given by both · ${a.pairs.model_only} only by this model · ${a.pairs.reference_only} only by the comparison annotator`)
      console.log(locale === 'zh'
        ? `    把参考标注当参考算：精确率 ${pct(a.precision)} · 召回率 ${pct(a.recall)} · F1 ${pct(a.f1)}（按标签平均的 F1 ${pct(a.macro_f1)}）——是一致程度，不是准确率`
        : `    Treating the comparison labels as the yardstick: precision ${pct(a.precision)} · recall ${pct(a.recall)} · F1 ${pct(a.f1)} (macro F1 ${pct(a.macro_f1)}) — agreement, not accuracy`)
      console.log(locale === 'zh'
        ? `    参考标注 ${a.works.reference} 篇，其中 ${a.works.with_suggestions} 篇这个模型有建议`
        : `    ${a.works.reference} works with comparison labels, ${a.works.with_suggestions} of them have suggestions from this model`)
      for (const t of a.per_tag.slice(0, 12)) {
        console.log(locale === 'zh'
          ? `      ${t.label}：两边都给 ${t.both} · 只有模型 ${t.model_only} · 只有参考 ${t.reference_only}（参考标注里 ${t.reference_works} 篇）`
          : `      ${t.label}: both ${t.both} · model only ${t.model_only} · comparison only ${t.reference_only} (${t.reference_works} works in the comparison labels)`)
      }
      if (a.per_tag.length > 12) console.log(`      … +${a.per_tag.length - 12}`)
    }
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
