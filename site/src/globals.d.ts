/**
 * 构建期由 site/build.ts 用 esbuild `define` 注入的常量：配置、词表、裁决参数、构建信息。
 * 页面不在运行时拉这些文件（file:// 下 fetch 拿不到），导出（export/v1）才在运行时拉。
 */
interface SmtConfig {
  owner: string
  repo: string
  /** 相对 site/dist 的导出目录（不带末尾斜杠） */
  exportPath: string
  issueTemplate: string
  maxIssueUrlBytes: number
  openalex: { baseUrl: string }
}

interface SmtFacetDef {
  label: Record<string, string>
  values: string[]
  maps_to: string | null
  locator_required: boolean
}

interface SmtVocab {
  facets: Record<string, SmtFacetDef>
  /** vocab/concepts/*.jsonl 的全部行（原样，页面用 readCommunityExport 同一套宽松读法） */
  concepts: unknown[]
}

declare const __SMT_CONFIG__: SmtConfig
declare const __SMT_VOCAB__: SmtVocab
/** config/smt.config.json 去掉 `_` 开头的键 */
declare const __SMT_POLICY__: Record<string, unknown>
declare const __SMT_BUILD__: { at: string; engine: string }
