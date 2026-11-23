/**
 * 质量评估：把每个模型的标签建议与维护者标的标准答案（`data/gold/*.jsonl`）对照，算法全部来自引擎 `scoreTagSets`。
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 只评标准答案覆盖到的作品；标准答案里写空数组表示「这篇确实没有这些标签」。
 *   · 没有标准答案时如实说没有——指标是 null，不是 0。
 *   · 结果随导出写成 `quality.json`（不在引擎契约里，宿主的读取函数不看它），所以每周的重放也会核到它。
 * 这些数只说明「与这份标准答案有多一致」；标准答案由谁标、够不够有代表性，写在 `data/gold/README.md`。
 * 用法：`pnpm evaluate [--root <dir>] [--lang zh|en]`
 */
import { pathToFileURL } from 'node:url'
import { presentTagQuality } from 'scholar-meta'
import { REPO_ROOT, loadAssertions, loadGold } from './lib/store.js'
import { evaluateModels } from './lib/quality-core.js'
import type { QualityReport } from './lib/quality-core.js'
import { argValue } from './export.js'

export { evaluateModels }
export type { QualityReport }

export function qualityOf(root: string = REPO_ROOT): QualityReport {
  return evaluateModels(loadAssertions(root).assertions, loadGold(root).rows)
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
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
