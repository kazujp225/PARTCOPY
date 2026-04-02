/**
 * Structure IR Compiler
 *
 * raw HTML → StructureNode tree
 * 元 DOM の親子構造を保持したまま、意味のあるノードツリーに変換する。
 * 汎用テンプレートへの丸め込みは行わない。
 */
import * as cheerio from 'cheerio'
import type { StructureNode, StructureKind, StyleNode, ContentSlot, SectionIR } from './structure-ir.js'

// Use `any` for cheerio element types to avoid version-specific type issues
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
  img: 'image',
  picture: 'image',
  svg: 'icon',
  video: 'image',
  button: 'button',
  ul: 'list',
  ol: 'list',
  li: 'list-item',
  form: 'form',
  input: 'input',
  textarea: 'textarea',
  select: 'input',
  hr: 'divider',
  br: 'divider',
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const INLINE_TAGS = new Set(['span', 'strong', 'em', 'b', 'i', 'u', 'small', 'sub', 'sup', 'mark', 'abbr', 'time', 'code'])
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'link', 'meta'])

// ============================================================
// Kind inference
// ============================================================

function inferKind(el: CheerioEl, $: cheerio.CheerioAPI, tag: string): StructureKind {
  // Direct tag mapping
  if (TAG_KIND_MAP[tag]) return TAG_KIND_MAP[tag]
  if (HEADING_TAGS.has(tag)) return 'text'
  if (INLINE_TAGS.has(tag)) return 'inline'

  // Anchor with button-like classes or short text
  if (tag === 'a') {
    const cls = (el.attr('class') || '').toLowerCase()
    const text = el.text().trim()
    if (/btn|button|cta/i.test(cls) || (text.length > 0 && text.length <= 30 && el.children().length === 0)) {
      return 'button'
    }
    return 'inline'
  }

  // Label
  if (tag === 'label') return 'text'
  if (tag === 'p') return 'text'

  // Table → treat as grid
  if (tag === 'table' || tag === 'tbody') return 'grid'
  if (tag === 'tr') return 'columns'
  if (tag === 'td' || tag === 'th') return 'container'

  // Check class hints for layout
  const cls = (el.attr('class') || '').toLowerCase()
  const style = (el.attr('style') || '').toLowerCase()

  // Grid
  if (/display:\s*grid/i.test(style) || /\bgrid\b/.test(cls)) return 'grid'
  // Flex row
  if (/display:\s*flex/i.test(style) && /flex-direction:\s*row/i.test(style)) return 'columns'
  if (/\bflex\b/.test(cls) && /\brow\b/.test(cls)) return 'columns'
  // Flex (default column)
  if (/display:\s*flex/i.test(style)) return 'stack'

  // Card-like repeated pattern
  if (/card|tile|item/i.test(cls)) return 'card'

  // Section / article / main / header / footer / nav
  if (['section', 'article', 'main', 'header', 'footer', 'nav', 'aside'].includes(tag)) return 'section'

  // Badge
  if (/badge|tag|label|chip/i.test(cls) && el.text().trim().length < 30) return 'badge'

  // Default container
  return 'container'
}

// ============================================================
// Style extraction
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
  el: CheerioEl,
  tag: string,
  kind: StructureKind,
  nodeId: string,
  slots: ContentSlot[]
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
    return
  }
}

// ============================================================
// Main compiler
// ============================================================

const MAX_DEPTH = 15
const MAX_CHILDREN = 80

function compileNode(
  el: CheerioEl,
  $: cheerio.CheerioAPI,
  styles: StyleNode[],
  slots: ContentSlot[],
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

  // Build attrs (safe subset)
  const attrs: Record<string, string> = {}
  const src = el.attr('src')
  const alt = el.attr('alt')
  const href = el.attr('href')
  const type = el.attr('type')
  const placeholder = el.attr('placeholder')
  const name = el.attr('name')
  if (src) attrs.src = src
  if (alt) attrs.alt = alt
  if (href) attrs.href = href
  if (type) attrs.type = type
  if (placeholder) attrs.placeholder = placeholder
  if (name) attrs.name = name

  // Text-only leaf nodes
  if (kind === 'text' || kind === 'badge' || kind === 'inline') {
    const directText = el.contents().toArray()
      .filter(n => n.type === 'text')
      .map(n => (n as any).data || '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim()

    // If it's a simple text node with no child elements, capture text
    if (el.children().length === 0) {
      const text = el.text().replace(/\s+/g, ' ').trim()
      if (text) {
        return {
          id,
          kind,
          htmlTag: tag,
          textContent: text,
          attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
        }
      }
      return null // empty node
    }
  }

  // Self-closing / leaf elements
  if (['img', 'input', 'textarea', 'hr', 'br', 'video'].includes(tag)) {
    return {
      id,
      kind,
      htmlTag: tag,
      attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
    }
  }

  // SVG: treat as icon leaf
  if (tag === 'svg') {
    return { id, kind: 'icon', htmlTag: 'svg' }
  }

  // Recurse into children
  const children: StructureNode[] = []
  const childEls = el.children().toArray().slice(0, MAX_CHILDREN)

  for (const child of childEls) {
    const childNode = compileNode($(child), $, styles, slots, depth + 1)
    if (childNode) children.push(childNode)
  }

  // If container has no meaningful children, check for text
  if (children.length === 0) {
    const text = el.text().replace(/\s+/g, ' ').trim()
    if (text && text.length > 0) {
      return {
        id,
        kind,
        htmlTag: tag,
        textContent: text.slice(0, 500),
        attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
      }
    }
    // Skip completely empty containers unless they have background/style
    if (!styleNode && !el.attr('class')) return null
  }

  // Detect card-group: container with 3+ repeated same-kind children
  if (children.length >= 3 && kind === 'container') {
    const kindCounts = new Map<string, number>()
    for (const c of children) {
      kindCounts.set(c.kind, (kindCounts.get(c.kind) || 0) + 1)
    }
    for (const [k, count] of kindCounts) {
      if (count >= 3 && count >= children.length * 0.6) {
        return {
          id,
          kind: 'card-group',
          htmlTag: tag,
          children,
          attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
        }
      }
    }
  }

  return {
    id,
    kind,
    htmlTag: tag,
    children: children.length > 0 ? children : undefined,
    textContent: children.length === 0 ? el.text().replace(/\s+/g, ' ').trim().slice(0, 500) || undefined : undefined,
    attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
  }
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

  // Find the root section element
  const root = $.root().children().first()
  const rootNode = compileNode(root, $, styles, slots, 0)

  const structure: StructureNode = rootNode || {
    id: nextId(),
    kind: 'section',
    htmlTag: 'div',
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
