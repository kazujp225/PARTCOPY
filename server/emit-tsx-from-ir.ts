/**
 * TSX + Scoped CSS Emitter (V2)
 *
 * SectionIR → TSX + CSS Module
 * 元 HTML の構造を保持したまま、編集可能な TSX と section-scoped CSS を出力する。
 * 汎用テンプレートへの丸め込みは行わない。
 */
import type { StructureNode, StyleNode, SectionIR, ContentSlot } from './structure-ir.js'

// ============================================================
// Class naming
// ============================================================

let classCounter = 0
function resetClassCounter() { classCounter = 0 }

function nextClass(hint: string): string {
  return `${hint}_${++classCounter}`
}

// ============================================================
// Style → CSS string
// ============================================================

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, m => '-' + m.toLowerCase())
}

function styleNodeToCss(style: StyleNode, className: string): string {
  const props: string[] = []
  for (const [key, val] of Object.entries(style)) {
    if (key === 'nodeId' || val == null) continue
    props.push(`  ${camelToKebab(key)}: ${val};`)
  }
  if (props.length === 0) return ''
  return `.${className} {\n${props.join('\n')}\n}`
}

// ============================================================
// HTML tag → JSX safe mapping
// ============================================================

const VOID_ELEMENTS = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'embed', 'wbr', 'col', 'area', 'base', 'track', 'param'])

const ATTR_RENAMES: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  autocomplete: 'autoComplete',
  crossorigin: 'crossOrigin',
}

function escapeJsxText(text: string): string {
  return text.replace(/[{}<>]/g, c => {
    if (c === '{') return '&#123;'
    if (c === '}') return '&#125;'
    if (c === '<') return '&lt;'
    if (c === '>') return '&gt;'
    return c
  })
}

// ============================================================
// Content slot references
// ============================================================

function findSlotForNode(nodeId: string, slots: ContentSlot[]): ContentSlot | undefined {
  return slots.find(s => s.nodeId === nodeId)
}

// ============================================================
// Node → JSX emitter
// ============================================================

interface EmitContext {
  componentName: string
  styles: Map<string, StyleNode>  // nodeId → StyleNode
  slots: ContentSlot[]
  cssRules: string[]
  classMap: Map<string, string>  // nodeId → className
  indent: number
}

function getOrCreateClass(nodeId: string, kind: string, ctx: EmitContext): string {
  let cls = ctx.classMap.get(nodeId)
  if (!cls) {
    cls = nextClass(kind)
    ctx.classMap.set(nodeId, cls)

    const style = ctx.styles.get(nodeId)
    if (style) {
      const rule = styleNodeToCss(style, cls)
      if (rule) ctx.cssRules.push(rule)
    }
  }
  return cls
}

function emitNode(node: StructureNode, ctx: EmitContext): string {
  const pad = '  '.repeat(ctx.indent)
  const tag = mapTag(node)
  const cls = ctx.styles.has(node.id) ? getOrCreateClass(node.id, node.kind, ctx) : null

  // Slot reference
  const slot = findSlotForNode(node.id, ctx.slots)

  // Self-closing elements
  if (VOID_ELEMENTS.has(tag)) {
    const attrs = buildAttrs(node, cls, ctx)
    return `${pad}<${tag}${attrs} />`
  }

  // SVG icon placeholder
  if (node.kind === 'icon') {
    return `${pad}<span className={styles.${cls || 'icon'}} aria-hidden="true" />`
  }

  // Leaf text node
  if (!node.children || node.children.length === 0) {
    const attrs = buildAttrs(node, cls, ctx)
    const text = node.textContent || ''

    if (slot && (slot.kind === 'heading' || slot.kind === 'text' || slot.kind === 'buttonLabel' || slot.kind === 'linkLabel')) {
      return `${pad}<${tag}${attrs}>{content.${ctx.componentName}.${slot.key}}</${tag}>`
    }

    if (text) {
      return `${pad}<${tag}${attrs}>${escapeJsxText(text)}</${tag}>`
    }

    return `${pad}<${tag}${attrs} />`
  }

  // Container with children
  const attrs = buildAttrs(node, cls, ctx)
  const childCtx = { ...ctx, indent: ctx.indent + 1 }
  const children = node.children
    .map(c => emitNode(c, childCtx))
    .filter(Boolean)
    .join('\n')

  if (!children) {
    return `${pad}<${tag}${attrs} />`
  }

  return `${pad}<${tag}${attrs}>\n${children}\n${pad}</${tag}>`
}

function mapTag(node: StructureNode): string {
  // Use original HTML tag if available
  if (node.htmlTag) {
    const tag = node.htmlTag.toLowerCase()
    // Map non-JSX-safe tags
    if (tag === 'main' || tag === 'header' || tag === 'footer' || tag === 'nav' ||
        tag === 'article' || tag === 'aside' || tag === 'section' ||
        tag === 'div' || tag === 'span' || tag === 'p' || tag === 'a' ||
        tag === 'img' || tag === 'button' || tag === 'form' ||
        tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option' ||
        tag === 'label' || tag === 'ul' || tag === 'ol' || tag === 'li' ||
        tag === 'table' || tag === 'tbody' || tag === 'thead' || tag === 'tr' || tag === 'td' || tag === 'th' ||
        tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6' ||
        tag === 'figure' || tag === 'figcaption' || tag === 'picture' || tag === 'source' ||
        tag === 'video' || tag === 'audio' || tag === 'details' || tag === 'summary' ||
        tag === 'dl' || tag === 'dt' || tag === 'dd' ||
        tag === 'blockquote' || tag === 'cite' || tag === 'time' ||
        tag === 'strong' || tag === 'em' || tag === 'small' || tag === 'sub' || tag === 'sup' ||
        tag === 'br' || tag === 'hr' || tag === 'mark' || tag === 'abbr' || tag === 'code' || tag === 'pre') {
      return tag
    }
    return 'div'
  }

  // Kind → tag fallback
  switch (node.kind) {
    case 'section': return 'section'
    case 'container': return 'div'
    case 'stack': return 'div'
    case 'inline': return 'span'
    case 'grid': return 'div'
    case 'columns': return 'div'
    case 'text': return 'p'
    case 'image': return 'img'
    case 'button': return 'button'
    case 'list': return 'ul'
    case 'list-item': return 'li'
    case 'card-group': return 'div'
    case 'card': return 'div'
    case 'form': return 'form'
    case 'input': return 'input'
    case 'textarea': return 'textarea'
    case 'divider': return 'hr'
    case 'badge': return 'span'
    case 'icon': return 'span'
    case 'raw': return 'div'
    default: return 'div'
  }
}

function buildAttrs(node: StructureNode, className: string | null, ctx: EmitContext): string {
  const parts: string[] = []

  if (className) {
    parts.push(`className={styles.${className}}`)
  }

  if (node.attrs) {
    for (let [key, val] of Object.entries(node.attrs)) {
      // Skip event handlers
      if (key.startsWith('on')) continue
      // Skip dangerous attrs
      if (key === 'srcdoc' || key === 'srcset') continue

      // Rename HTML attrs to JSX
      const jsxKey = ATTR_RENAMES[key] || key

      // Neutralize links
      if (key === 'href') {
        val = '#'
      }

      // Replace external images with placeholder
      if (key === 'src' && /^https?:\/\//i.test(val)) {
        val = '/assets/placeholder.svg'
      }

      parts.push(`${jsxKey}="${val.replace(/"/g, '&quot;')}"`)
    }
  }

  // Root section attrs
  if (node.kind === 'section' && ctx.indent === 1) {
    // data-partcopy-section is added at the wrapper level
  }

  return parts.length > 0 ? ' ' + parts.join(' ') : ''
}

// ============================================================
// Public API
// ============================================================

export interface EmitResult {
  tsx: string
  css: string
  contentKeys: Record<string, string>  // slot key → original value
}

export function emitTsxFromIR(
  ir: SectionIR,
  componentName: string
): EmitResult {
  resetClassCounter()

  // Build style lookup
  const styleMap = new Map<string, StyleNode>()
  for (const s of ir.styles) {
    styleMap.set(s.nodeId, s)
  }

  const ctx: EmitContext = {
    componentName,
    styles: styleMap,
    slots: ir.contentSlots,
    cssRules: [],
    classMap: new Map(),
    indent: 2,
  }

  const bodyJsx = emitNode(ir.structure, ctx)

  // Build content keys
  const contentKeys: Record<string, string> = {}
  for (const slot of ir.contentSlots) {
    contentKeys[slot.key] = slot.originalValue
  }

  // TSX file
  const tsx = `import { content } from '../../content/site-content'
import styles from './${componentName}.module.css'

export default function ${componentName}() {
  return (
    <section className={styles.root} data-partcopy-section="${ir.sourceSectionId}" data-layout-lock="true">
${bodyJsx}
    </section>
  )
}
`

  // CSS file: root wrapper + all extracted styles
  const rootRule = `.root {\n  /* section root */\n}`
  const allRules = [rootRule, ...ctx.cssRules].join('\n\n')
  const css = `/* ${componentName} — auto-generated from source HTML */\n/* Do not rename classes — they are referenced in the TSX */\n\n${allRules}\n`

  return { tsx, css, contentKeys }
}
