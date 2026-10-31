/**
 * 本地 PDF：只在浏览器里读前两页的文字找 DOI；找不到就取最长的一行当标题。文件不上传。
 * pdfjs 的 worker 作为独立文件放在 dist 里（`pdf.worker.min.mjs`），CSP 的 script-src 'self' 允许。
 */
import * as pdfjs from 'pdfjs-dist'

const DOI = /10\.\d{4,9}\/[^\s"<>]+/
let configured = false

export type PdfResult = { kind: 'doi'; doi: string } | { kind: 'title'; line: string } | { kind: 'error' }

export async function scanPdf(file: File): Promise<PdfResult> {
  try {
    if (!configured) {
      pdfjs.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs'
      configured = true
    }
    const data = new Uint8Array(await file.arrayBuffer())
    const doc = await pdfjs.getDocument({ data, disableAutoFetch: true, isEvalSupported: false }).promise
    const lines: string[] = []
    const pages = Math.min(2, doc.numPages)
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      let line = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        line += item.str
        if (item.hasEOL) { lines.push(line.trim()); line = '' } else line += ' '
      }
      if (line.trim()) lines.push(line.trim())
    }
    await doc.destroy()
    const text = lines.join('\n')
    const m = DOI.exec(text)
    if (m) return { kind: 'doi', doi: m[0].replace(/[.,;)\]]+$/, '') }
    const longest = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length >= 4).sort((a, b) => b.length - a.length)[0]
    return longest ? { kind: 'title', line: longest.slice(0, 300) } : { kind: 'error' }
  } catch {
    return { kind: 'error' }
  }
}
