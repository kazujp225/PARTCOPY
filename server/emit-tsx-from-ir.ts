/**
 * TSX + Scoped CSS Emitter (V2 Fix)
 *
 * SectionIR → TSX + CSS Module
 *
 * Fix 2: 元 class を保持し、IR class と結合
 * Fix 3: .scoped.css import 対応
 */
import type { StructureNode, StyleNode, SectionIR, ContentSlot } from './structure-ir.js'

// ============================================================
// Class naming
// ============================================================

let classCounter = 0
function resetClassCounter() { classCounter = 0 }
function nextClass(hint: string): string { return `${hint}_${++classCounter}` }

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
// JSX helpers
// ============================================================

const VOID_ELEMENTS = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'embed', 'wbr', 'col', 'area', 'base', 'track', 'param'])

const ATTR_RENAMES: Record<string, string> = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex',
  readonly: 'readOnly', maxlength: 'maxLength',
  colspan: 'colSpan', rowspan: 'rowSpan',
  autocomplete: 'autoComplete', crossorigin: 'crossOrigin',
  'accept-charset': 'acceptCharset', 'http-equiv': 'httpEquiv',
  accesskey: 'accessKey', cellpadding: 'cellPadding', cellspacing: 'cellSpacing',
}

function escapeJsxText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/{/g, '&#123;')
    .replace(/}/g, '&#125;')
}

// ============================================================
// Emit context
// ============================================================

interface EmitContext {
  componentName: string
  styles: Map<string, StyleNode>
  slots: ContentSlot[]
  cssRules: string[]
  classMap: Map<string, string>  // nodeId → generated className
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

// ============================================================
// Attribute building (Fix 2: class merge)
// ============================================================

function buildAttrs(node: StructureNode, ctx: EmitContext): string {
  const parts: string[] = []

  // Class merge: original class + IR-generated class
  const origClass = node.attrs?.class || ''
  const hasStyle = ctx.styles.has(node.id)
  const genClass = hasStyle ? getOrCreateClass(node.id, node.kind, ctx) : null

  if (genClass && origClass) {
    // Both: merge
    parts.push(`className={\`\${styles.${genClass}} ${origClass.replace(/`/g, '')}\`}`)
  } else if (genClass) {
    parts.push(`className={styles.${genClass}}`)
  } else if (origClass) {
    parts.push(`className="${origClass.replace(/"/g, '&quot;')}"`)
  }

  // Other attrs
  if (node.attrs) {
    for (let [key, val] of Object.entries(node.attrs)) {
      if (key === 'class') continue  // handled above
      if (key.startsWith('on')) continue  // event handlers

      // Neutralize links
      if (key === 'href') val = '#'

      // JSX rename
      const jsxKey = ATTR_RENAMES[key] || (key.includes('-') ? key : key)
      // aria-* and data-* keep kebab-case

      parts.push(`${jsxKey}="${val.replace(/"/g, '&quot;')}"`)
    }
  }

  return parts.length > 0 ? ' ' + parts.join(' ') : ''
}

// ============================================================
// Tag mapping
// ============================================================

const SAFE_TAGS = new Set([
  'div', 'span', 'p', 'a', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'img', 'picture', 'source', 'video', 'audio', 'figure', 'figcaption',
  'button', 'form', 'input', 'textarea', 'select', 'option', 'label',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'details', 'summary', 'blockquote', 'cite', 'time', 'pre', 'code',
  'strong', 'em', 'small', 'sub', 'sup', 'mark', 'abbr',
  'br', 'hr',
])

function mapTag(node: StructureNode): string {
  if (node.htmlTag && SAFE_TAGS.has(node.htmlTag.toLowerCase())) {
    return node.htmlTag.toLowerCase()
  }
  // Fallback to div for unknown tags
  return 'div'
}

// ============================================================
// Node emitter
// ============================================================

function emitNode(node: StructureNode, ctx: EmitContext): string {
  const pad = '  '.repeat(ctx.indent)
  const tag = mapTag(node)

  // SVG → span with original class
  if (node.kind === 'icon') {
    const origClass = node.attrs?.class
    if (origClass) {
      return `${pad}<span className="${origClass}" aria-hidden="true" />`
    }
    return `${pad}<span aria-hidden="true" />`
  }

  // Void elements
  if (VOID_ELEMENTS.has(tag)) {
    const attrs = buildAttrs(node, ctx)
    return `${pad}<${tag}${attrs} />`
  }

  // Leaf text node with slot
  const slot = ctx.slots.find(s => s.nodeId === node.id)

  if (!node.children || node.children.length === 0) {
    const attrs = buildAttrs(node, ctx)
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
  const attrs = buildAttrs(node, ctx)
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

// ============================================================
// Public API
// ============================================================

export interface EmitResult {
  tsx: string
  css: string
  contentKeys: Record<string, string>
}

export function emitTsxFromIR(
  ir: SectionIR,
  componentName: string,
  scopeClass?: string
): EmitResult {
  resetClassCounter()

  const styleMap = new Map<string, StyleNode>()
  for (const s of ir.styles) styleMap.set(s.nodeId, s)

  const ctx: EmitContext = {
    componentName,
    styles: styleMap,
    slots: ir.contentSlots,
    cssRules: [],
    classMap: new Map(),
    indent: 2,
  }

  const bodyJsx = emitNode(ir.structure, ctx)

  // Content keys
  const contentKeys: Record<string, string> = {}
  for (const slot of ir.contentSlots) {
    contentKeys[slot.key] = slot.originalValue
  }

  // Root className: merge module root + scope class
  const rootClassParts: string[] = ['styles.root']
  if (scopeClass) rootClassParts.push(`'${scopeClass}'`)
  const rootClassName = rootClassParts.length === 1
    ? `{${rootClassParts[0]}}`
    : `{[${rootClassParts.join(', ')}].join(' ')}`

  // TSX file (Fix 3: import .scoped.css)
  const tsx = `import { content } from '../../content/site-content'
import styles from './${componentName}.module.css'
import './${componentName}.scoped.css'

export default function ${componentName}() {
  return (
    <section className=${rootClassName} data-partcopy-section="${ir.sourceSectionId}" data-layout-lock="true">
${bodyJsx}
    </section>
  )
}
`

  // CSS Module (minimal: root + inline-style derived rules)
  const rootRule = `.root {\n  /* section wrapper */\n}`
  const allRules = [rootRule, ...ctx.cssRules].join('\n\n')
  const css = `/* ${componentName} — CSS Module */\n\n${allRules}\n`

  return { tsx, css, contentKeys }
}
