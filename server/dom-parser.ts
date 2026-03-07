/**
 * DOM Parser - Phase 5.5
 * セクションの outerHTML を解析し、編集可能なノードツリーに分解する。
 *
 * 責務:
 * 1. 危険要素の除去（script, onevent, etc.）
 * 2. 編集可能ノードの識別と stable_key 付与
 * 3. resolved HTML 生成（主要 computed style をインライン化）
 * 4. section_nodes レコード用データ生成
 */
import type { Page } from 'puppeteer'
import type { DetectedSection } from './section-detector.js'

export interface DOMNode {
  stableKey: string
  nodeType: string
  tagName: string
  orderIndex: number
  textContent: string | null
  attrs: Record<string, string>
  bbox: { x: number; y: number; width: number; height: number } | null
  computedStyle: Record<string, string>
  editable: boolean
  selectorPath: string
  children: DOMNode[]
}

export interface DOMSnapshot {
  resolvedHtml: string
  sanitizedHtml: string
  nodes: DOMNode[]
  nodeCount: number
}

/**
 * Puppeteer page.evaluate 内でセクションDOMを解析し、
 * 編集可能ノードツリーと resolved HTML を生成する。
 */
export async function parseSectionDOM(
  page: Page,
  section: DetectedSection,
  sectionIndex: number
): Promise<DOMSnapshot> {
  const result = await page.evaluate((outerHTML: string, bbox: any, secIdx: number) => {
    if (typeof (globalThis as any).__name === 'undefined') (globalThis as any).__name = (t: any) => t

    // --- Step 1: パースと危険要素除去 ---
    const parser = new DOMParser()
    const doc = parser.parseFromString(
      `<div id="__pc_root">${outerHTML}</div>`,
      'text/html'
    )
    const root = doc.getElementById('__pc_root')!

    // 危険要素・属性の除去
    const DANGEROUS_TAGS = new Set(['script', 'noscript', 'iframe', 'object', 'embed', 'applet'])
    const DANGEROUS_ATTR_PREFIX = ['on'] // onclick, onload, etc.

    const removeDangerous = (el: Element) => {
      // 危険タグ除去
      for (const tag of DANGEROUS_TAGS) {
        el.querySelectorAll(tag).forEach(d => d.remove())
      }
      // 危険属性除去
      const allEls = el.querySelectorAll('*')
      allEls.forEach(child => {
        const toRemove: string[] = []
        for (const attr of child.attributes) {
          if (DANGEROUS_ATTR_PREFIX.some(p => attr.name.toLowerCase().startsWith(p) && attr.name.length > 2)) {
            toRemove.push(attr.name)
          }
          if (attr.name === 'href' && attr.value.trim().toLowerCase().startsWith('javascript:')) {
            toRemove.push(attr.name)
          }
        }
        toRemove.forEach(a => child.removeAttribute(a))
      })
    }
    removeDangerous(root)

    const sanitizedHtml = root.innerHTML

    // --- Step 2: 編集可能ノードの識別 ---
    const EDITABLE_TAGS: Record<string, string> = {
      'h1': 'heading', 'h2': 'heading', 'h3': 'heading',
      'h4': 'heading', 'h5': 'heading', 'h6': 'heading',
      'p': 'paragraph', 'span': 'text',
      'a': 'link', 'button': 'button',
      'img': 'image', 'picture': 'image', 'video': 'video',
      'input': 'input', 'textarea': 'input', 'select': 'input',
      'li': 'list_item', 'ul': 'list', 'ol': 'list',
      'svg': 'icon', 'form': 'form',
      'div': 'container', 'section': 'container', 'article': 'container',
      'header': 'container', 'footer': 'container', 'nav': 'container',
      'main': 'container', 'aside': 'container', 'figure': 'container',
      'figcaption': 'text', 'blockquote': 'text',
      'strong': 'text', 'em': 'text', 'b': 'text', 'i': 'text',
      'label': 'text', 'small': 'text', 'time': 'text',
      'address': 'text', 'cite': 'text', 'dl': 'list',
      'dt': 'list_item', 'dd': 'list_item'
    }

    // コンテナ系: 子要素を再帰的に探索する
    const CONTAINER_TYPES = new Set(['container', 'list', 'form', 'root'])

    // 直接テキスト持ちで編集対象
    const TEXT_EDITABLE = new Set(['heading', 'paragraph', 'text', 'link', 'button', 'list_item'])

    // 属性編集対象
    const ATTR_EDITABLE = new Set(['image', 'video', 'link', 'button', 'input'])

    let nodeCounter = 0

    const buildSelectorPath = (el: Element, withinRoot: Element): string => {
      const parts: string[] = []
      let cur: Element | null = el
      while (cur && cur !== withinRoot) {
        const tag = cur.tagName.toLowerCase()
        const parent: Element | null = cur.parentElement
        if (parent) {
          const curTag = cur.tagName
          const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === curTag)
          if (siblings.length > 1) {
            const idx = siblings.indexOf(cur) + 1
            parts.unshift(`${tag}:nth-of-type(${idx})`)
          } else {
            parts.unshift(tag)
          }
        } else {
          parts.unshift(tag)
        }
        cur = parent
      }
      return parts.join(' > ')
    }

    const parseNode = (el: Element, parentKey: string, depth: number): DOMNode | null => {
      if (depth > 15) return null

      const tag = el.tagName.toLowerCase()

      // スキップ対象
      if (['br', 'hr', 'wbr', 'meta', 'link', 'style', 'col', 'colgroup', 'source', 'track'].includes(tag)) {
        return null
      }

      const nodeType = EDITABLE_TAGS[tag] || 'other'
      const idx = nodeCounter++
      const stableKey = `${parentKey}.${tag}[${idx}]`

      // 属性取得
      const attrs: Record<string, string> = {}
      for (const attr of el.attributes) {
        attrs[attr.name] = attr.value
      }

      // テキスト内容（直接テキストノードのみ、子要素のテキストは含まない）
      let textContent: string | null = null
      if (TEXT_EDITABLE.has(nodeType)) {
        // 直接テキストを取得（子要素含む）
        textContent = (el.textContent || '').trim().slice(0, 1000)
      }

      const editable = TEXT_EDITABLE.has(nodeType) || ATTR_EDITABLE.has(nodeType)
      const selectorPath = buildSelectorPath(el, root)

      // 子要素の再帰処理
      const children: DOMNode[] = []
      if (CONTAINER_TYPES.has(nodeType) || nodeType === 'other') {
        for (const child of el.children) {
          const childNode = parseNode(child as Element, stableKey, depth + 1)
          if (childNode) children.push(childNode)
        }
      }

      return {
        stableKey,
        nodeType,
        tagName: tag,
        orderIndex: idx,
        textContent,
        attrs,
        bbox: null, // DOMParser では位置情報取れない。後でライブDOMから補完。
        computedStyle: {},
        editable,
        selectorPath,
        children
      }
    }

    // ルートの子要素を処理
    const rootChildren: DOMNode[] = []
    const rootElement = root.firstElementChild || root
    for (const child of rootElement.children) {
      const node = parseNode(child as Element, `s${secIdx}`, 0)
      if (node) rootChildren.push(node)
    }

    const rootNode: DOMNode = {
      stableKey: `s${secIdx}`,
      nodeType: 'root',
      tagName: rootElement.tagName.toLowerCase(),
      orderIndex: 0,
      textContent: null,
      attrs: {},
      bbox: null,
      computedStyle: {},
      editable: false,
      selectorPath: '',
      children: rootChildren
    }

    // ノードをフラット化してカウント
    const countNodes = (n: DOMNode): number => {
      return 1 + n.children.reduce((sum, c) => sum + countNodes(c), 0)
    }

    return {
      sanitizedHtml,
      resolvedHtml: sanitizedHtml, // Phase 1では sanitized = resolved
      rootNode,
      nodeCount: countNodes(rootNode)
    }
  }, section.outerHTML, section.boundingBox, sectionIndex)

  // rootNode からフラットなノードリストを生成
  const flatNodes: DOMNode[] = []
  const flatten = (node: DOMNode) => {
    flatNodes.push(node)
    for (const child of node.children) flatten(child)
  }
  flatten(result.rootNode)

  return {
    resolvedHtml: result.resolvedHtml,
    sanitizedHtml: result.sanitizedHtml,
    nodes: flatNodes,
    nodeCount: result.nodeCount
  }
}

/**
 * ライブ DOM からノードの bbox と computed style を補完する。
 * page.evaluate 内で selector_path を使って実DOMにアクセスする。
 */
export async function enrichNodesFromLiveDOM(
  page: Page,
  sectionIndex: number,
  nodes: DOMNode[]
): Promise<DOMNode[]> {
  // 編集可能ノードの selector_path を収集
  const editableNodes = nodes.filter(n => n.editable && n.selectorPath)
  if (editableNodes.length === 0) return nodes

  const selectors = editableNodes.map(n => n.selectorPath)

  const enrichments = await page.evaluate((sels: string[]) => {
    if (typeof (globalThis as any).__name === 'undefined') (globalThis as any).__name = (t: any) => t

    const results: Array<{
      bbox: { x: number; y: number; width: number; height: number } | null
      style: Record<string, string>
    }> = []

    // セクション要素群を取得
    const STYLE_PROPS = [
      'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily',
      'textAlign', 'lineHeight', 'letterSpacing', 'padding', 'margin',
      'borderRadius', 'display', 'width', 'height'
    ]

    for (const sel of sels) {
      try {
        const el = document.querySelector(sel)
        if (!el) {
          results.push({ bbox: null, style: {} })
          continue
        }
        const rect = el.getBoundingClientRect()
        const cs = window.getComputedStyle(el)
        const style: Record<string, string> = {}
        for (const prop of STYLE_PROPS) {
          style[prop] = cs.getPropertyValue(
            prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase())
          )
        }
        results.push({
          bbox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          style
        })
      } catch {
        results.push({ bbox: null, style: {} })
      }
    }
    return results
  }, selectors)

  // ノードに反映
  for (let i = 0; i < editableNodes.length; i++) {
    const enrichment = enrichments[i]
    if (enrichment) {
      editableNodes[i].bbox = enrichment.bbox
      editableNodes[i].computedStyle = enrichment.style
    }
  }

  return nodes
}
