/**
 * DOM Parser
 * 編集用 resolved snapshot を live DOM から生成する。
 *
 * 強化ポイント:
 * - ancestor context を保持
 * - sibling は ghost clone にしてレイアウト影響を残す
 * - computed style を全要素に inline 化
 * - pseudo element / form state / currentSrc を可能な範囲で凍結
 */
import type { Page } from 'puppeteer'

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

const STYLE_SUMMARY_PROPS = [
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'fontFamily',
  'textAlign',
  'lineHeight',
  'letterSpacing',
  'padding',
  'margin',
  'borderRadius',
  'display',
  'width',
  'height'
]

export async function parseSectionDOM(
  page: Page,
  section: { domPath: string; outerHTML: string },
  sectionIndex: number
): Promise<DOMSnapshot> {
  const result = await page.evaluate((domPath: string, secIdx: number, summaryProps: string[]) => {
    if (typeof (globalThis as any).__name === 'undefined') (globalThis as any).__name = (t: any) => t

    const EDITABLE_TAGS: Record<string, string> = {
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      p: 'paragraph',
      span: 'text',
      a: 'link',
      button: 'button',
      img: 'image',
      picture: 'image',
      video: 'video',
      input: 'input',
      textarea: 'input',
      select: 'input',
      li: 'list_item',
      ul: 'list',
      ol: 'list',
      svg: 'icon',
      form: 'form',
      div: 'container',
      section: 'container',
      article: 'container',
      header: 'container',
      footer: 'container',
      nav: 'container',
      main: 'container',
      aside: 'container',
      figure: 'container',
      figcaption: 'text',
      blockquote: 'text',
      strong: 'text',
      em: 'text',
      b: 'text',
      i: 'text',
      label: 'text',
      small: 'text',
      time: 'text',
      address: 'text',
      cite: 'text',
      dl: 'list',
      dt: 'list_item',
      dd: 'list_item'
    }

    const TEXT_EDITABLE = new Set(['heading', 'paragraph', 'text', 'link', 'button', 'list_item'])
    const ATTR_EDITABLE = new Set(['image', 'video', 'link', 'button', 'input'])
    const DANGEROUS_TAGS = new Set(['script', 'noscript', 'iframe', 'object', 'embed', 'applet'])
    const SKIPPED_HEAD_TAGS = new Set(['script', 'noscript', 'style', 'link', 'meta'])

    const rootElement = document.querySelector(domPath)
    if (!rootElement) {
      return {
        resolvedHtml: '',
        sanitizedHtml: '',
        rootNode: null,
        nodeCount: 0
      }
    }

    const snapshotDoc = document.implementation.createHTMLDocument(document.title || '')
    let nodeCounter = 0

    const copySafeAttrs = (from: Element, to: Element) => {
      for (const attr of Array.from(from.attributes)) {
        const name = attr.name.toLowerCase()
        const value = attr.value
        if (name.startsWith('on')) continue
        if (name === 'style') continue
        if ((name === 'href' || name === 'src') && value.trim().toLowerCase().startsWith('javascript:')) continue
        to.setAttribute(attr.name, value)
      }
    }

    const buildStyleText = (styleDecl: CSSStyleDeclaration, excluded: Set<string> = new Set()) => {
      const parts: string[] = []
      for (let i = 0; i < styleDecl.length; i++) {
        const prop = styleDecl[i]
        if (excluded.has(prop)) continue
        const value = styleDecl.getPropertyValue(prop)
        if (!value) continue
        parts.push(`${prop}:${value};`)
      }
      return parts.join('')
    }

    const computedStyleText = (el: Element, pseudo?: '::before' | '::after') => {
      return buildStyleText(window.getComputedStyle(el, pseudo || null), new Set(['content']))
    }

    const normalizePseudoContent = (content: string) => {
      if (!content || content === 'none' || content === 'normal') return null
      if ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'"))) {
        return content.slice(1, -1)
      }
      return content
    }

    const shouldMaterializePseudo = (styleDecl: CSSStyleDeclaration) => {
      const content = styleDecl.getPropertyValue('content')
      if (content && content !== 'none' && content !== 'normal') return true
      if (styleDecl.getPropertyValue('background-image') && styleDecl.getPropertyValue('background-image') !== 'none') return true
      if (styleDecl.getPropertyValue('background-color') && styleDecl.getPropertyValue('background-color') !== 'rgba(0, 0, 0, 0)') return true
      if (styleDecl.getPropertyValue('border-style') && styleDecl.getPropertyValue('border-style') !== 'none') return true
      const width = styleDecl.getPropertyValue('width')
      const height = styleDecl.getPropertyValue('height')
      return Boolean(
        (width && width !== 'auto' && width !== '0px') ||
        (height && height !== 'auto' && height !== '0px')
      )
    }

    const applyElementState = (liveEl: Element, clone: Element) => {
      if (liveEl instanceof HTMLImageElement && liveEl.currentSrc) {
        clone.setAttribute('src', liveEl.currentSrc)
      }

      if (liveEl instanceof HTMLInputElement) {
        clone.setAttribute('value', liveEl.value)
        if (liveEl.checked) clone.setAttribute('checked', '')
      }

      if (liveEl instanceof HTMLTextAreaElement) {
        clone.textContent = liveEl.value
      }

      if (liveEl instanceof HTMLOptionElement && liveEl.selected) {
        clone.setAttribute('selected', '')
      }

      if (liveEl instanceof HTMLDetailsElement && liveEl.open) {
        clone.setAttribute('open', '')
      }

      if (liveEl instanceof HTMLVideoElement) {
        if (liveEl.currentSrc) clone.setAttribute('src', liveEl.currentSrc)
        if (liveEl.poster) clone.setAttribute('poster', liveEl.poster)
      }

      if (liveEl instanceof HTMLAudioElement && liveEl.currentSrc) {
        clone.setAttribute('src', liveEl.currentSrc)
      }
    }

    const materializePseudo = (
      liveEl: Element,
      doc: Document,
      pseudo: '::before' | '::after',
      ghost: boolean
    ) => {
      const pseudoStyle = window.getComputedStyle(liveEl, pseudo)
      if (!shouldMaterializePseudo(pseudoStyle)) return null

      const pseudoEl = doc.createElement('span')
      pseudoEl.setAttribute('aria-hidden', 'true')
      pseudoEl.setAttribute('data-pc-pseudo', pseudo.replace(/:/g, ''))

      const content = normalizePseudoContent(pseudoStyle.getPropertyValue('content'))
      if (content !== null) pseudoEl.textContent = content

      let styleText = buildStyleText(pseudoStyle, new Set(['content']))
      if (ghost) styleText += 'visibility:hidden !important;pointer-events:none !important;'
      if (styleText) pseudoEl.setAttribute('style', styleText)

      return pseudoEl
    }

    const cloneFrozenSubtree = (liveEl: Element, doc: Document, ghost: boolean): Element | null => {
      const tag = liveEl.tagName.toLowerCase()
      if (DANGEROUS_TAGS.has(tag)) return null

      if (liveEl instanceof HTMLCanvasElement) {
        const img = doc.createElement('img')
        copySafeAttrs(liveEl, img)
        img.setAttribute('src', liveEl.toDataURL())
        let canvasStyle = computedStyleText(liveEl)
        if (ghost) canvasStyle += 'visibility:hidden !important;pointer-events:none !important;'
        if (canvasStyle) img.setAttribute('style', canvasStyle)
        img.setAttribute('data-pc-placeholder', 'true')
        return img
      }

      const clone = doc.createElement(liveEl.tagName)
      copySafeAttrs(liveEl, clone)
      applyElementState(liveEl, clone)

      let styleText = computedStyleText(liveEl)
      if (ghost) styleText += 'visibility:hidden !important;pointer-events:none !important;'
      if (styleText) clone.setAttribute('style', styleText)
      if (ghost) clone.setAttribute('data-pc-placeholder', 'true')

      const beforePseudo = materializePseudo(liveEl, doc, '::before', ghost)
      if (beforePseudo) clone.appendChild(beforePseudo)

      for (const childNode of Array.from(liveEl.childNodes)) {
        if (childNode.nodeType === Node.TEXT_NODE) {
          clone.appendChild(doc.createTextNode(childNode.textContent || ''))
          continue
        }
        if (childNode.nodeType !== Node.ELEMENT_NODE) continue
        const childClone = cloneFrozenSubtree(childNode as Element, doc, ghost)
        if (childClone) clone.appendChild(childClone)
      }

      const afterPseudo = materializePseudo(liveEl, doc, '::after', ghost)
      if (afterPseudo) clone.appendChild(afterPseudo)

      return clone
    }

    const buildRelativeSelectorPath = (el: Element): string => {
      if (el === rootElement) return ''

      const parts: string[] = []
      let current: Element | null = el
      while (current && current !== rootElement) {
        const currentElement: Element = current
        const tag = currentElement.tagName.toLowerCase()
        const parent: Element | null = currentElement.parentElement
        if (parent) {
          const siblings = Array.from(parent.children).filter((child): child is Element => child.tagName === currentElement.tagName)
          if (siblings.length > 1) {
            parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(currentElement) + 1})`)
          } else {
            parts.unshift(tag)
          }
        } else {
          parts.unshift(tag)
        }
        current = parent
      }
      return parts.join(' > ')
    }

    const summarizeStyle = (el: Element) => {
      const styleDecl = window.getComputedStyle(el)
      const summary: Record<string, string> = {}
      for (const prop of summaryProps) {
        summary[prop] = styleDecl.getPropertyValue(prop.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`))
      }
      return summary
    }

    const cloneEditableTree = (
      liveEl: Element,
      parentKey: string,
      depth: number
    ): { clone: Element; node: DOMNode } | null => {
      const tag = liveEl.tagName.toLowerCase()
      if (DANGEROUS_TAGS.has(tag)) return null

      const stableKey = depth === 0 ? `s${secIdx}` : `${parentKey}.${tag}[${nodeCounter}]`
      const orderIndex = nodeCounter++
      const nodeType = depth === 0 ? 'root' : (EDITABLE_TAGS[tag] || 'other')
      const editable = depth > 0 && (TEXT_EDITABLE.has(nodeType) || ATTR_EDITABLE.has(nodeType))

      const clone = liveEl instanceof HTMLCanvasElement
        ? snapshotDoc.createElement('img')
        : snapshotDoc.createElement(liveEl.tagName)

      copySafeAttrs(liveEl, clone)
      applyElementState(liveEl, clone)
      clone.setAttribute('data-pc-key', stableKey)

      if (liveEl instanceof HTMLCanvasElement) {
        clone.setAttribute('src', liveEl.toDataURL())
      }

      const styleText = computedStyleText(liveEl)
      if (styleText) clone.setAttribute('style', styleText)

      const beforePseudo = materializePseudo(liveEl, snapshotDoc, '::before', false)
      if (beforePseudo) clone.appendChild(beforePseudo)

      const children: DOMNode[] = []
      for (const childNode of Array.from(liveEl.childNodes)) {
        if (childNode.nodeType === Node.TEXT_NODE) {
          clone.appendChild(snapshotDoc.createTextNode(childNode.textContent || ''))
          continue
        }
        if (childNode.nodeType !== Node.ELEMENT_NODE) continue
        const childResult = cloneEditableTree(childNode as Element, stableKey, depth + 1)
        if (!childResult) continue
        clone.appendChild(childResult.clone)
        children.push(childResult.node)
      }

      const afterPseudo = materializePseudo(liveEl, snapshotDoc, '::after', false)
      if (afterPseudo) clone.appendChild(afterPseudo)

      const attrs: Record<string, string> = {}
      for (const attr of Array.from(clone.attributes)) {
        if (attr.name === 'style') continue
        attrs[attr.name] = attr.value
      }

      const rect = liveEl.getBoundingClientRect()
      const node: DOMNode = {
        stableKey,
        nodeType,
        tagName: clone.tagName.toLowerCase(),
        orderIndex,
        textContent: TEXT_EDITABLE.has(nodeType) ? (liveEl.textContent || '').trim().slice(0, 1000) : null,
        attrs,
        bbox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        computedStyle: summarizeStyle(liveEl),
        editable,
        selectorPath: depth === 0 ? domPath : buildRelativeSelectorPath(liveEl),
        children
      }

      return { clone, node }
    }

    copySafeAttrs(document.documentElement, snapshotDoc.documentElement)
    copySafeAttrs(document.body, snapshotDoc.body)

    const htmlStyle = computedStyleText(document.documentElement)
    if (htmlStyle) snapshotDoc.documentElement.setAttribute('style', htmlStyle)
    const bodyStyle = computedStyleText(document.body)
    if (bodyStyle) snapshotDoc.body.setAttribute('style', bodyStyle)

    const chain: Element[] = []
    let current: Element | null = rootElement
    while (current && current !== document.body) {
      chain.unshift(current)
      current = current.parentElement
    }

    let liveParent: Element = document.body
    let cloneParent: Element = snapshotDoc.body
    let rootNode: DOMNode | null = null

    for (let depth = 0; depth < chain.length; depth++) {
      const pathNode = chain[depth]
      const siblings = Array.from(liveParent.children)
        .filter((child): child is Element => !SKIPPED_HEAD_TAGS.has(child.tagName.toLowerCase()))

      for (const sibling of siblings) {
        if (sibling === pathNode) {
          if (depth === chain.length - 1) {
            const editableTree = cloneEditableTree(pathNode, `s${secIdx}`, 0)
            if (editableTree) {
              cloneParent.appendChild(editableTree.clone)
              rootNode = editableTree.node
              cloneParent = editableTree.clone
            }
          } else {
            const shell = snapshotDoc.createElement(pathNode.tagName)
            copySafeAttrs(pathNode, shell)
            const shellStyle = computedStyleText(pathNode)
            if (shellStyle) shell.setAttribute('style', shellStyle)
            shell.setAttribute('data-pc-shell', 'true')
            cloneParent.appendChild(shell)
            cloneParent = shell
          }
        } else {
          const ghost = cloneFrozenSubtree(sibling, snapshotDoc, true)
          if (ghost) cloneParent.appendChild(ghost)
        }
      }

      liveParent = pathNode
    }

    const countNodes = (node: DOMNode): number => 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0)

    return {
      resolvedHtml: `<!DOCTYPE html>\n${snapshotDoc.documentElement.outerHTML}`,
      sanitizedHtml: `<!DOCTYPE html>\n${snapshotDoc.documentElement.outerHTML}`,
      rootNode,
      nodeCount: rootNode ? countNodes(rootNode) : 0
    }
  }, section.domPath, sectionIndex, STYLE_SUMMARY_PROPS)

  if (!result.rootNode) {
    return {
      resolvedHtml: section.outerHTML,
      sanitizedHtml: section.outerHTML,
      nodes: [],
      nodeCount: 0
    }
  }

  const nodes: DOMNode[] = []
  const flatten = (node: DOMNode) => {
    nodes.push(node)
    for (const child of node.children) flatten(child)
  }
  flatten(result.rootNode)

  return {
    resolvedHtml: result.resolvedHtml,
    sanitizedHtml: result.sanitizedHtml,
    nodes,
    nodeCount: result.nodeCount
  }
}

export async function enrichNodesFromLiveDOM(
  _page: Page,
  _sectionIndex: number,
  nodes: DOMNode[]
): Promise<DOMNode[]> {
  return nodes
}
