// LaTeX 文本 → HTML 渲染管线：
// 原始 LaTeX → 按 $…$ / $$…$$ / \(…\) / \[…\] 分段 → KaTeX renderToString（throwOnError:false，
// 失败段红框显示原文）→ 文本段 HTML 转义、@[TAG] 转内部链接、\xymatrix 原样 <pre> + 小注。
import katex from 'katex'

export type SegmentKind = 'text' | 'math-inline' | 'math-display' | 'diagram'

export interface Segment {
  kind: SegmentKind
  body: string
  /** 原始定界文本（渲染失败时展示） */
  raw: string
}

const TAG_RE = /@\[([A-Za-z0-9]{4})\]/g

/**
 * Stacks 官方 preamble.tex 的宏，转写为 KaTeX macros（KaTeX 已内置 \lim \boxtimes 等，不覆盖）。
 * 保证 \Spec \Hom \SheafHom \Curvesstack 等真实渲染而不是红色未知命令。
 */
const KATEX_MACROS: Record<string, string> = {
  '\\colim': '\\mathop{\\mathrm{colim}}\\nolimits',
  '\\Spec': '\\mathop{\\mathrm{Spec}}',
  '\\Hom': '\\mathop{\\mathrm{Hom}}\\nolimits',
  '\\Ext': '\\mathop{\\mathrm{Ext}}\\nolimits',
  '\\SheafHom': '\\mathop{\\mathcal{H}\\!\\mathit{om}}\\nolimits',
  '\\SheafExt': '\\mathop{\\mathcal{E}\\!\\mathit{xt}}\\nolimits',
  '\\Sch': '\\mathit{Sch}',
  '\\Mor': '\\mathop{\\mathrm{Mor}}\\nolimits',
  '\\Ob': '\\mathop{\\mathrm{Ob}}\\nolimits',
  '\\Sh': '\\mathop{\\mathit{Sh}}\\nolimits',
  '\\NL': '\\mathop{N\\!L}\\nolimits',
  '\\CH': '\\mathop{\\mathrm{CH}}\\nolimits',
  '\\proetale': '\\text{pro-\\acute{e}tale}',
  '\\etale': '\\text{\\acute{e}tale}',
  '\\QCoh': '\\mathit{QCoh}',
  '\\Ker': '\\mathop{\\mathrm{Ker}}',
  '\\Im': '\\mathop{\\mathrm{Im}}',
  '\\Coker': '\\mathop{\\mathrm{Coker}}',
  '\\Coim': '\\mathop{\\mathrm{Coim}}',
  '\\QCohstack': '\\mathcal{QC}\\!\\mathit{oh}',
  '\\Cohstack': '\\mathcal{C}\\!\\mathit{oh}',
  '\\Spacesstack': '\\mathcal{S}\\!\\mathit{paces}',
  '\\Quotfunctor': '\\mathrm{Quot}',
  '\\Hilbfunctor': '\\mathrm{Hilb}',
  '\\Curvesstack': '\\mathcal{C}\\!\\mathit{urves}',
  '\\Polarizedstack': '\\mathcal{P}\\!\\mathit{olarized}',
  '\\Complexesstack': '\\mathcal{C}\\!\\mathit{omplexes}',
  '\\Pic': '\\mathop{\\mathrm{Pic}}\\nolimits',
  '\\Picardstack': '\\mathcal{P}\\!\\mathit{ic}',
  '\\Picardfunctor': '\\mathrm{Pic}',
  '\\Deformationcategory': '\\mathcal{D}\\!\\mathit{ef}',
  // 黑板粗体字母（Stacks 常用 \CC \NN \ZZ \QQ \RR \PP \FF 等）
  '\\AA': '\\mathbb{A}', '\\BB': '\\mathbb{B}', '\\CC': '\\mathbb{C}',
  '\\EE': '\\mathbb{E}', '\\FF': '\\mathbb{F}', '\\GG': '\\mathbb{G}',
  '\\HH': '\\mathbb{H}', '\\II': '\\mathbb{I}', '\\KK': '\\mathbb{K}',
  '\\LL': '\\mathbb{L}', '\\MM': '\\mathbb{M}', '\\NN': '\\mathbb{N}',
  '\\OO': '\\mathbb{O}', '\\PP': '\\mathbb{P}', '\\QQ': '\\mathbb{Q}',
  '\\RR': '\\mathbb{R}', '\\TT': '\\mathbb{T}', '\\UU': '\\mathbb{U}',
  '\\VV': '\\mathbb{V}', '\\WW': '\\mathbb{W}', '\\XX': '\\mathbb{X}',
  '\\YY': '\\mathbb{Y}', '\\ZZ': '\\mathbb{Z}',
}

/**
 * 文本预处理：Stacks 的 LaTeX 源不是为 KaTeX 写的，先做一次温和清理。
 * 只动文本层结构，数学段内容由调用方另行处理。
 */
function sanitizeLatex(src: string): string {
  let s = src
  // reference / slogan 环境是引用备注，整体去除；history 环境保留正文去掉标记
  s = s.replace(/\\begin\{(reference|slogan)\}[\s\S]*?\\end\{\1\}/g, ' ')
  s = s.replace(/\\(begin|end)\{history\}/g, ' ')
  // \cite[opt]{key} / \cite{key} → [key]
  s = s.replace(/\\cite(\[[^\]]*\])?\{([^}]*)\}/g, '[$2]')
  // \label{...} 已在管线中消费，显示层去掉
  s = s.replace(/\\label\{[^}]*\}/g, '')
  // enumerate / itemize → 行内编号/圆点（按环境状态计数）
  let counters: number[] = []
  s = s.replace(/\\begin\{enumerate\}|\\end\{enumerate\}|\\begin\{itemize\}|\\end\{itemize\}|\\item(\[[^\]]*\])?/g,
    (m) => {
      if (m.startsWith('\\begin{enumerate}')) { counters.push(1); return ' ' }
      if (m.startsWith('\\end{enumerate}')) { counters.pop(); return ' ' }
      if (m.startsWith('\\begin{itemize}')) { counters.push(-1); return ' ' }
      if (m.startsWith('\\end{itemize}')) { counters.pop(); return ' ' }
      // \item
      const top = counters.length ? counters[counters.length - 1] : -1
      if (top > 0) { counters[counters.length - 1] = top + 1; return ` (${top}) ` }
      return ' • '
    })
  // 常见文本格式命令：保留内容去掉命令（迭代处理嵌套，去掉花括号）
  for (let k = 0; k < 4; k++) {
    const t = s.replace(/\\(emph|textit|textbf|textsl|texttt|textnormal)\{([^{}]*)\}/g, '$2')
    if (t === s) break
    s = t
  }
  // 排版命令与不可断行空格
  s = s.replace(/\\(medskip|smallskip|bigskip|noindent|par|newpage|pagebreak|linebreak)\b/g, ' ')
  s = s.replace(/\\(quad|qquad|;|,)\b/g, ' ')
  s = s.replace(/~/g, ' ')
  return s
}

/** KaTeX 不支持 align/equation 等环境名，转成其支持的 aligned/gathered */
function sanitizeMath(body: string): string {
  return body
    .replace(/\\begin\{(align|equation|eqnarray)\*?\}/g, '\\begin{aligned}')
    .replace(/\\end\{(align|equation|eqnarray)\*?\}/g, '\\end{aligned}')
    .replace(/\\begin\{gather\*?\}/g, '\\begin{gathered}')
    .replace(/\\end\{gather\*?\}/g, '\\end{gathered}')
    .replace(/\\begin\{split\}/g, '\\begin{aligned}')
    .replace(/\\end\{split\}/g, '\\end{aligned}')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 从 pos 处（应为 '{'）做平衡括号匹配，返回闭括号下标；失败返回 -1 */
function matchBraces(src: string, pos: number): number {
  let depth = 0
  for (let i = pos; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      i++ // 跳过转义字符
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function findUnescaped(src: string, needle: string, from: number): number {
  let i = from
  for (;;) {
    const j = src.indexOf(needle, i)
    if (j < 0) return -1
    // 统计前面的连续反斜杠，奇数个表示被转义
    let bs = 0
    for (let k = j - 1; k >= 0 && src[k] === '\\'; k--) bs++
    if (bs % 2 === 0) return j
    i = j + needle.length
  }
}

/** 把原始 LaTeX 切成文本 / 数学 / 交换图段 */
export function segmentLatex(src: string): Segment[] {
  const segs: Segment[] = []
  let buf = ''
  let i = 0
  const n = src.length

  const flush = () => {
    if (buf) {
      segs.push({ kind: 'text', body: buf, raw: buf })
      buf = ''
    }
  }

  while (i < n) {
    // \xymatrix{...}（KaTeX 不支持，原样展示）
    if (src.startsWith('\\xymatrix', i)) {
      let j = i + '\\xymatrix'.length
      while (j < n && /\s/.test(src[j])) j++
      if (j < n && src[j] === '{') {
        const end = matchBraces(src, j)
        if (end > 0) {
          flush()
          const raw = src.slice(i, end + 1)
          segs.push({ kind: 'diagram', body: raw, raw })
          i = end + 1
          continue
        }
      }
      buf += src[i]
      i++
      continue
    }

    const two = src.slice(i, i + 2)
    if (two === '$$') {
      const end = findUnescaped(src, '$$', i + 2)
      if (end >= 0) {
        flush()
        const raw = src.slice(i, end + 2)
        const body = src.slice(i + 2, end)
        if (body.includes('\\xymatrix')) segs.push({ kind: 'diagram', body: raw, raw })
        else segs.push({ kind: 'math-display', body, raw })
        i = end + 2
        continue
      }
    } else if (two === '\\[') {
      const end = findUnescaped(src, '\\]', i + 2)
      if (end >= 0) {
        flush()
        const raw = src.slice(i, end + 2)
        const body = src.slice(i + 2, end)
        if (body.includes('\\xymatrix')) segs.push({ kind: 'diagram', body: raw, raw })
        else segs.push({ kind: 'math-display', body, raw })
        i = end + 2
        continue
      }
    } else if (two === '\\(') {
      const end = findUnescaped(src, '\\)', i + 2)
      if (end >= 0) {
        flush()
        const raw = src.slice(i, end + 2)
        segs.push({ kind: 'math-inline', body: src.slice(i + 2, end), raw })
        i = end + 2
        continue
      }
    } else if (src[i] === '$' && src[i - 1] !== '\\') {
      const end = findUnescaped(src, '$', i + 1)
      if (end > i + 1) {
        flush()
        const raw = src.slice(i, end + 1)
        const body = src.slice(i + 1, end)
        if (body.includes('\\xymatrix')) segs.push({ kind: 'diagram', body: raw, raw })
        else segs.push({ kind: 'math-inline', body, raw })
        i = end + 1
        continue
      }
    }
    buf += src[i]
    i++
  }
  flush()
  return segs
}

function renderMath(body: string, displayMode: boolean, raw: string): string {
  try {
    return katex.renderToString(sanitizeMath(body), {
      throwOnError: false,
      displayMode,
      strict: false,
      trust: false,
      maxExpand: 500,
      macros: KATEX_MACROS,
    })
  } catch {
    // throwOnError:false 下极少触发；兜底红框显示原文
    return `<span class="math-error">${escapeHtml(raw)}</span>`
  }
}

/** 渲染单个段落为 HTML */
export function renderParagraph(src: string): string {
  const segs = segmentLatex(sanitizeLatex(src))
  let out = ''
  for (const s of segs) {
    if (s.kind === 'text') {
      let html = escapeHtml(s.body)
      html = html.replace(
        TAG_RE,
        (_m, tag: string) =>
          `<a class="tag-link" data-tag="${tag.toUpperCase()}" href="#${tag.toUpperCase()}">${tag.toUpperCase()}</a>`,
      )
      out += html.replace(/\n/g, ' ')
    } else if (s.kind === 'math-inline') {
      out += renderMath(s.body, false, s.raw)
    } else if (s.kind === 'math-display') {
      out += renderMath(s.body, true, s.raw)
    } else {
      out += `<pre class="xymatrix-src">${escapeHtml(s.body)}</pre><div class="xymatrix-note">diagram source</div>`
    }
  }
  return out
}

/** 按空行分段（供分片渲染） */
export function splitParagraphs(src: string): string[] {
  return src
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}
