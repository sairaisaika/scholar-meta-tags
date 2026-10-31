/**
 * 静态页构建：esbuild 把 site/src/main.ts 打成 site/dist/main.js（IIFE，浏览器端，file:// 也能开），
 * 复制样式、pdfjs 的 worker、../vocab → dist/vocab、../export/v1（若存在）→ dist/export/v1，写 dist/index.html（带 CSP meta）。
 * 配置 / 词表 / 裁决参数在构建期注入（esbuild define），导出在运行时读。用法：pnpm site:build；pnpm site:dev（--watch）。
 */
import { build, context, type BuildOptions } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = dirname(fileURLToPath(import.meta.url))
const root = join(site, '..')
const dist = join(site, 'dist')
const watch = process.argv.includes('--watch')

const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
const stripPrivate = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')))

const config = stripPrivate(readJson(join(site, 'config.json')))
const facets = (readJson(join(root, 'vocab', 'facets.json')).facets ?? {}) as Record<string, unknown>
const conceptsDir = join(root, 'vocab', 'concepts')
const concepts = existsSync(conceptsDir)
  ? readdirSync(conceptsDir).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) =>
    readFileSync(join(conceptsDir, f), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as unknown))
  : []
const policy = stripPrivate(readJson(join(root, 'config', 'smt.config.json')))
const engine = String(readJson(join(root, 'node_modules', 'scholar-meta', 'package.json')).version ?? '')

const options: BuildOptions = {
  entryPoints: [join(site, 'src', 'main.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  outfile: join(dist, 'main.js'),
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    __SMT_CONFIG__: JSON.stringify(config),
    __SMT_VOCAB__: JSON.stringify({ facets, concepts }),
    __SMT_POLICY__: JSON.stringify(policy),
    __SMT_BUILD__: JSON.stringify({ at: new Date().toISOString(), engine }),
  },
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.openalex.org; img-src 'self' data:"

function html(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>scholar-meta-tags</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="style.css">
</head>
<body>
<div id="app"><noscript>This page needs JavaScript. / 这个页面需要 JavaScript。</noscript></div>
<script src="main.js"></script>
</body>
</html>
`
}

function copyAssets() {
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), html())
  cpSync(join(site, 'style.css'), join(dist, 'style.css'))
  const worker = join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')
  if (existsSync(worker)) cpSync(worker, join(dist, 'pdf.worker.min.mjs'))
  const vocabDir = join(root, 'vocab')
  if (existsSync(vocabDir)) cpSync(vocabDir, join(dist, 'vocab'), { recursive: true })
  const exportDir = join(root, 'export', 'v1')
  rmSync(join(dist, 'export'), { recursive: true, force: true })
  if (existsSync(exportDir)) cpSync(exportDir, join(dist, 'export', 'v1'), { recursive: true })
  // Pages 不走 Jekyll（文件名、目录名原样）
  writeFileSync(join(dist, '.nojekyll'), '')
}

rmSync(dist, { recursive: true, force: true })
copyAssets()
if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log(`watching… (${dist})`)
} else {
  await build(options)
  const kb = Math.round(readFileSync(join(dist, 'main.js')).length / 1024)
  console.log(`site/dist/index.html + main.js (${kb} KB) + style.css${existsSync(join(root, 'export', 'v1')) ? ' + export/v1' : ' (no export/v1: empty shelf)'}`)
}
