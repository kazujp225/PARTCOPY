/**
 * Structure IR Compiler (V2 Fix)
 *
 * raw HTML → StructureNode tree
 * 元 DOM の親子構造を保持したまま、意味のあるノードツリーに変換する。
 *
 * Fix 1: root 選定の厳密化（sibling 保持）
 * Fix 2: class, id, data-attr, aria-attr を attrs に保持
 */
import * as cheerio from 'cheerio'
import type { StructureNode, StructureKind, StyleNode, ContentSlot, SectionIR } from './structure-ir.js'

type CheerioEl = cheerio.Cheerio<any>

let nodeCounter = 0
function nextId(prefix = 'n'): string {
  return `${prefix}-${++nodeCounter}`
}

export function resetNodeCounter() {
  nodeCounter = 0
}

// ============================================================
// Tag → Kind mapping
// ============================================================

const TAG_KIND_MAP: Record<string, StructureKind> = {
  img: 'image', picture: 'image', svg: 'icon', video: 'image',
  button: 'button',
  ul: 'list', ol: 'list', li: 'list-item',
  form: 'form', input: 'input', textarea: 'textarea', select: 'input',
  hr: 'divider', br: 'divider',
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const INLINE_TAGS = new Set(['span', 'strong', 'em', 'b', 'i', 'u', 'small', 'sub', 'sup', 'mark', 'abbr', 'time', 'code'])
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'link', 'meta'])

// Attrs to preserve (Fix 2)
const SKIP_ATTR_PREFIXES = ['on']  // event handlers
const SKIP_ATTRS = new Set(['style', 'srcdoc'])

function shouldKeepAttr(name: string): boolean {
  if (SKIP_ATTRS.has(name)) return false
  for (const prefix of SKIP_ATTR_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length && name[prefix.length] >= 'A' && name[prefix.length] <= 'z') {
      return false  // onclick, onload, etc.
    }
  }
  return true
}

// ============================================================
// Kind inference
// ============================================================

function inferKind(el: CheerioEl, $: cheerio.CheerioAPI, tag: string): StructureKind {
  if (TAG_KIND_MAP[tag]) return TAG_KIND_MAP[tag]
  if (HEADING_TAGS.has(tag)) return 'text'
  if (INLINE_TAGS.has(tag)) return 'inline'

  if (tag === 'a') {
    const cls = (el.attr('class') || '').toLowerCase()
    const text = el.text().trim()
    if (/btn|button|cta/i.test(cls) || (text.length > 0 && text.length <= 30 && el.children().length === 0)) {
      return 'button'
    }
    return 'inline'
  }

  if (tag === 'label') return 'text'
  if (tag === 'p') return 'text'
  if (tag === 'table' || tag === 'tbody') return 'grid'
  if (tag === 'tr') return 'columns'
  if (tag === 'td' || tag === 'th') return 'container'

  const cls = (el.attr('class') || '').toLowerCase()
  const style = (el.attr('style') || '').toLowerCase()

  if (/display:\s*grid/i.test(style) || /\bgrid\b/.test(cls)) return 'grid'
  if (/display:\s*flex/i.test(style) && /flex-direction:\s*row/i.test(style)) return 'columns'
  if (/\bflex\b/.test(cls) && /\brow\b/.test(cls)) return 'columns'
  if (/display:\s*flex/i.test(style)) return 'stack'
  if (/card|tile/i.test(cls)) return 'card'
  if (['section', 'article', 'main', 'header', 'footer', 'nav', 'aside'].includes(tag)) return 'section'
  if (/badge|chip/i.test(cls) && el.text().trim().length < 30) return 'badge'

  return 'container'
}

// ============================================================
// Style extraction (inline style → StyleNode)
// ============================================================

const STYLE_PROPS: (keyof StyleNode)[] = [
  'display', 'flexDirection', 'flexWrap', 'justifyContent', 'alignItems',
  'gridTemplateColumns', 'gap', 'padding', 'margin',
  'width', 'height', 'minHeight', 'maxWidth',
  'textAlign', 'fontSize', 'fontWeight', 'fontFamily',
  'lineHeight', 'letterSpacing', 'textTransform', 'textDecoration',
  'color', 'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition',
  'border', 'borderRadius', 'boxShadow', 'opacity',
  'objectFit', 'position', 'top', 'left', 'right', 'bottom',
  'overflow', 'zIndex', 'listStyleType', 'whiteSpace', 'transition',
]

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, m => '-' + m.toLowerCase())
}

function extractInlineStyle(el: CheerioEl, nodeId: string): StyleNode | null {
  const raw = el.attr('style')
  if (!raw) return null

  const style: StyleNode = { nodeId }
  let hasAny = false

  for (const prop of STYLE_PROPS) {
    const kebab = camelToKebab(prop)
    const re = new RegExp(`${kebab}\\s*:\\s*([^;]+)`, 'i')
    const m = raw.match(re)
    if (m) {
      ;(style as any)[prop] = m[1].trim()
      hasAny = true
    }
  }

  return hasAny ? style : null
}

// ============================================================
// Content slot extraction
// ============================================================

function extractSlot(
  el: CheerioEl, tag: string, kind: StructureKind,
  nodeId: string, slots: ContentSlot[]
) {
  if (kind === 'text' && HEADING_TAGS.has(tag)) {
    const text = el.text().replace(/\s+/g, ' ').trim()
    if (text && text.length < 200) {
      slots.push({ key: `heading_${slots.filter(s => s.kind === 'heading').length}`, kind: 'heading', originalValue: text, nodeId })
    }
    return
  }
  if (kind === 'text' && tag === 'p') {
    const text = el.text().replace(/\s+/g, ' ').trim()
    if (text && text.length > 5) {
      slots.push({ key: `text_${slots.filter(s => s.kind === 'text').length}`, kind: 'text', originalValue: text.slice(0, 300), nodeId })
    }
    return
  }
  if (kind === 'button') {
    const text = el.text().replace(/\s+/g, ' ').trim()
    if (text && text.length <= 50) {
      slots.push({ key: `cta_${slots.filter(s => s.kind === 'buttonLabel').length}`, kind: 'buttonLabel', originalValue: text, nodeId })
    }
    return
  }
  if (kind === 'image') {
    const alt = el.attr('alt') || ''
    if (alt) {
      slots.push({ key: `img_${slots.filter(s => s.kind === 'imageAlt').length}`, kind: 'imageAlt', originalValue: alt, nodeId })
    }
  }
}

// ============================================================
// Attr extraction (Fix 2: preserve class/id/data-*/aria-*)
// ============================================================

function extractAttrs(el: CheerioEl): Record<string, string> | undefined {
  const rawAttrs = (el.get(0) as any)?.attribs
  if (!rawAttrs) return undefined

  const attrs: Record<string, string> = {}
  for (const [name, val] of Object.entries(rawAttrs)) {
    if (!shouldKeepAttr(name)) continue
    if (name === 'style') continue  // handled by Style IR
    attrs[name] = String(val)
  }

  return Object.keys(attrs).length > 0 ? attrs : undefined
}

// ============================================================
// Node compiler
// ============================================================

const MAX_DEPTH = 15
const MAX_CHILDREN = 100

function compileNode(
  el: CheerioEl, $: cheerio.CheerioAPI,
  styles: StyleNode[], slots: ContentSlot[],
  depth: number
): StructureNode | null {
  if (depth > MAX_DEPTH) return null

  const domNode = el.get(0)
  if (!domNode || domNode.type !== 'tag') return null

  const tag = (domNode.tagName || '').toLowerCase()
  if (SKIP_TAGS.has(tag)) return null

  const kind = inferKind(el, $, tag)
  const id = nextId()

  // Extract inline style
  const styleNode = extractInlineStyle(el, id)
  if (styleNode) styles.push(styleNode)

  // Extract content slot
  extractSlot(el, tag, kind, id, slots)

  // Extract ALL relevant attrs (Fix 2)
  const attrs = extractAttrs(el)

  // Self-closing / leaf elements
  if (['img', 'input', 'textarea', 'hr', 'br', 'video'].includes(tag)) {
    return { id, kind, htmlTag: tag, attrs }
  }

  // SVG: treat as icon leaf, preserve class
  if (tag === 'svg') {
    return { id, kind: 'icon', htmlTag: 'svg', attrs }
  }

  // Text-only leaf nodes
  if ((kind === 'text' || kind === 'badge' || kind === 'inline') && el.children().length === 0) {
    const text = el.text().replace(/\s+/g, ' ').trim()
    if (text) {
      return { id, kind, htmlTag: tag, textContent: text, attrs }
    }
    // Keep empty elements that have class (might be styled)
    if (attrs?.class) return { id, kind, htmlTag: tag, attrs }
    return null
  }

  // Recurse into children
  const children: StructureNode[] = []
  const childEls = el.children().toArray().slice(0, MAX_CHILDREN)

  for (const child of childEls) {
    const childNode = compileNode($(child), $, styles, slots, depth + 1)
    if (childNode) children.push(childNode)
  }

  // Container with no meaningful children
  if (children.length === 0) {
    const text = el.text().replace(/\s+/g, ' ').trim()
    if (text && text.length > 0) {
      return { id, kind, htmlTag: tag, textContent: text.slice(0, 500), attrs }
    }
    // Keep if has class or style (might be a styled empty block like spacer/bg)
    if (styleNode || attrs?.class) {
      return { id, kind, htmlTag: tag, attrs }
    }
    return null
  }

  // Detect card-group
  if (children.length >= 3 && kind === 'container') {
    const kindCounts = new Map<string, number>()
    for (const c of children) kindCounts.set(c.kind, (kindCounts.get(c.kind) || 0) + 1)
    for (const [, count] of kindCounts) {
      if (count >= 3 && count >= children.length * 0.6) {
        return { id, kind: 'card-group', htmlTag: tag, children, attrs }
      }
    }
  }

  return {
    id, kind, htmlTag: tag,
    children: children.length > 0 ? children : undefined,
    textContent: children.length === 0 ? el.text().replace(/\s+/g, ' ').trim().slice(0, 500) || undefined : undefined,
    attrs,
  }
}

// ============================================================
// Root selection (Fix 1: handle multiple siblings)
// ============================================================

function findRootCandidates($: cheerio.CheerioAPI): CheerioEl[] {
  // Try body first
  const body = $('body')
  const parent: CheerioEl = body.length > 0 ? body : ($.root() as any)

  const candidates: CheerioEl[] = []
  parent.children().each((_: any, child: any) => {
    if ((child as any).type !== 'tag') return
    const tag = ((child as any).tagName || '').toLowerCase()
    if (SKIP_TAGS.has(tag)) return
    candidates.push($(child))
  })

  return candidates
}

// ============================================================
// Public API
// ============================================================

export function compileHtmlToStructureIR(
  html: string,
  meta: {
    sectionId: string
    family: string
    screenshotPath?: string
    sourceUrl?: string
    sourceDomain?: string
  }
): SectionIR {
  resetNodeCounter()
  const $ = cheerio.load(html)
  const styles: StyleNode[] = []
  const slots: ContentSlot[] = []

  // Fix 1: proper root selection
  const candidates = findRootCandidates($)

  let structure: StructureNode

  if (candidates.length === 0) {
    // Empty: synthetic section
    structure = { id: nextId(), kind: 'section', htmlTag: 'div' }
  } else if (candidates.length === 1) {
    // Single root
    const rootNode = compileNode(candidates[0], $, styles, slots, 0)
    structure = rootNode || { id: nextId(), kind: 'section', htmlTag: 'div' }
  } else {
    // Multiple siblings: synthetic wrapper to preserve all
    const children: StructureNode[] = []
    for (const candidate of candidates) {
      const node = compileNode(candidate, $, styles, slots, 0)
      if (node) children.push(node)
    }
    structure = {
      id: nextId(),
      kind: 'section',
      htmlTag: 'div',
      children: children.length > 0 ? children : undefined,
    }
  }

  // Ensure root is 'section' kind
  if (structure.kind !== 'section') {
    structure.kind = 'section'
  }

  return {
    id: `ir-${meta.sectionId}`,
    sourceSectionId: meta.sectionId,
    family: meta.family,
    structure,
    styles,
    contentSlots: slots,
    references: {
      screenshotPath: meta.screenshotPath || '',
      sourceUrl: meta.sourceUrl || '',
      sourceDomain: meta.sourceDomain || '',
    },
    constraints: {
      layoutLocked: true,
      preserveOrder: true,
      preserveColumns: true,
      preserveBackground: true,
      preserveDensity: true,
    },
  }
}
