/**
 * 质量评估：把每个模型的标签建议、以及社区裁决的结果，与维护者标的标准答案（`data/gold/*.jsonl`）对照；算法全部来自引擎
 * `scoreTagSets`（标签）与 `scoreLabelAgreement`（研究设计）。
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 只评标准答案覆盖到的作品；标准答案里写空数组表示「这篇确实没有这些标签」。
 *   · 没有标准答案时如实说没有——指标是 null，不是 0。
 *   · 结果随导出写成 `quality.json`（不在引擎契约里，宿主的读取函数不看它），所以每周的重放也会核到它。
 * 这些数只说明「与这份标准答案有多一致」；标准答案由谁标、够不够有代表性，写在 `data/gold/README.md`。
 * 用法：`pnpm evaluate [--root <dir>] [--lang zh|en]`
 */
import { pathToFileURL } from 'node:url'
import { presentLabelAgreement, presentTagQuality } from 'scholar-meta'
import { REPO_ROOT, loadAssertions, loadBlocklist, loadConfig, loadGold, loadVocab, loadWorks, policyOf } from './lib/store.js'
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
  return evaluateQuality(assertions, loadGold(root).rows, works)
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
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
