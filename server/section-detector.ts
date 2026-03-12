/**
 * Section Detector v2
 * Smarter section extraction: unwrap large containers, detect inner sections.
 * Preserves rich features for classification and canonicalization.
 */
import type { Page } from 'puppeteer'

export interface DetectedSection {
  index: number
  tagName: string
  outerHTML: string
  previewHTML: string
  textContent: string
  domPath: string
  boundingBox: { x: number; y: number; width: number; height: number }
  computedStyles: {
    backgroundColor: string
    backgroundImage: string
    fontSize: string
    fontFamily: string
    padding: string
    display: string
    position: string
    textAlign: string
    color: string
  }
  features: {
    headingCount: number
    headingTexts: string[]
    linkCount: number
    buttonCount: number
    formCount: number
    imageCount: number
    imageSources: string[]
    cardCount: number
    childCount: number
    listItemCount: number
    hasVideo: boolean
    hasSvg: boolean
    textLength: number
    positionRatio: number
    repeatedChildPattern: string | null
  }
  classTokens: string[]
  idTokens: string[]
}

export async function detectSections(page: Page): Promise<DetectedSection[]> {
  return page.evaluate(() => {
    if (typeof (globalThis as any).__name === 'undefined') (globalThis as any).__name = (t: any) => t

    const MIN_HEIGHT = 40
    const MIN_WIDTH = 200
    const MAX_SECTION_HEIGHT_RATIO = 1.5 // sections taller than 1.5x viewport get unwrapped
    const IGNORE_TAGS = new Set(['script', 'style', 'link', 'meta', 'noscript', 'br', 'hr', 'svg'])
    const HARD_SECTION_TAGS = new Set(['nav', 'header', 'footer'])
    const SECTIONISH_TAGS = new Set(['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'])
    const MICRO_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'small', 'label', 'li', 'dt', 'dd'])
    const SECTION_HINT_RE = /\b(hero|feature|service|section|block|band|panel|faq|accordion|cta|contact|form|pricing|plan|footer|header|nav|menu|news|blog|voice|testimonial|company|about|gallery|works|flow|step|mv|fv|kv)\b/i

    const visibleChildren = (el: Element) => Array.from(el.children).filter(child => {
      const tag = child.tagName.toLowerCase()
      if (IGNORE_TAGS.has(tag)) return false
      const rect = child.getBoundingClientRect()
      return rect.height >= MIN_HEIGHT && rect.width >= MIN_WIDTH
    })

    const getClassSignature = (el: Element) => {
      const tag = el.tagName.toLowerCase()
      const classes = Array.from(el.classList).slice(0, 3).sort().join('.')
      return classes ? `${tag}.${classes}` : tag
    }

    const getSiblingSignatureCount = (el: Element) => {
      const parent = el.parentElement
      if (!parent) return 1
      const signature = getClassSignature(el)
      return Array.from(parent.children).filter(child => getClassSignature(child) === signature).length
    }

    const getSignals = (el: Element) => {
      const rect = el.getBoundingClientRect()
      const tag = el.tagName.toLowerCase()
      const textContent = (el.textContent || '').trim()
      const childCount = el.children.length
      const headingCount = el.querySelectorAll(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6').length
      const imageCount = el.querySelectorAll(':scope img, :scope picture, :scope [style*="background-image"]').length
      const formCount = el.querySelectorAll(':scope form, :scope input, :scope textarea, :scope select').length
      const buttonCount = el.querySelectorAll(':scope button, :scope a[href], :scope input[type="submit"], :scope .btn, :scope [class*="button"], :scope [class*="btn"]').length
      const listItemCount = el.querySelectorAll(':scope li').length
      const tokens = `${el.id || ''} ${Array.from(el.classList).join(' ')}`
      const repeatedChildren = visibleChildren(el)
      const childSignatureCounts = repeatedChildren.reduce<Record<string, number>>((acc, child) => {
        const signature = getClassSignature(child)
        acc[signature] = (acc[signature] || 0) + 1
        return acc
      }, {})
      const maxRepeatedChildren = Object.values(childSignatureCounts).sort((a, b) => b - a)[0] || 0

      return {
        rect,
        tag,
        textLength: textContent.length,
        childCount,
        headingCount,
        imageCount,
        formCount,
        buttonCount,
        listItemCount,
        hasBoundaryHint: SECTION_HINT_RE.test(tokens) || SECTIONISH_TAGS.has(tag),
        repeatedChildCluster: maxRepeatedChildren >= 3,
        siblingPatternCount: getSiblingSignatureCount(el)
      }
    }

    const computeSectionScore = (el: Element) => {
      const signal = getSignals(el)
      let score = 0
      if (HARD_SECTION_TAGS.has(signal.tag)) score += 6
      if (SECTIONISH_TAGS.has(signal.tag)) score += 3
      if (signal.hasBoundaryHint) score += 2
      if (signal.headingCount > 0) score += 2
      if (signal.formCount > 0) score += 2
      if (signal.imageCount > 0) score += 1
      if (signal.buttonCount > 0) score += 1
      if (signal.listItemCount >= 3) score += 1
      if (signal.repeatedChildCluster) score += 2
      if (signal.rect.height >= 160) score += 1
      if (signal.textLength >= 120) score += 1
      if (MICRO_TAGS.has(signal.tag)) score -= 4
      if (signal.rect.height < 80) score -= 3
      if (signal.childCount <= 1 && signal.textLength < 180 && !signal.hasBoundaryHint) score -= 2
      if (signal.siblingPatternCount >= 3 && signal.rect.height < 160 && !signal.hasBoundaryHint) score -= 3
      return score
    }

    const isPotentialSectionElement = (el: Element) => {
      const signal = getSignals(el)

      if (signal.rect.height < MIN_HEIGHT || signal.rect.width < MIN_WIDTH) return false
      if (HARD_SECTION_TAGS.has(signal.tag)) return true
      if (MICRO_TAGS.has(signal.tag)) return false
      if (signal.siblingPatternCount >= 4 && signal.rect.height < 140 && signal.headingCount <= 1 && signal.formCount === 0) return false
      if (signal.childCount === 0 && signal.textLength < 320) return false
      if (signal.childCount <= 1 && signal.textLength < 180 && !signal.hasBoundaryHint && signal.imageCount === 0 && signal.formCount === 0) return false

      return computeSectionScore(el) >= 2
    }

    const getDominantChild = (el: Element) => {
      const rect = el.getBoundingClientRect()
      const children = visibleChildren(el)
      if (children.length === 0) return null

      const dominant = children.filter(child => {
        const childRect = child.getBoundingClientRect()
        return childRect.height >= rect.height * 0.6 && childRect.width >= rect.width * 0.7
      })

      return dominant.length === 1 ? dominant[0] : null
    }

    // ---- Step 1: Collect semantic candidates ----
    const allSemantic = new Set<Element>()
    document.querySelectorAll('header, nav, main, section, article, aside, footer').forEach(el => {
      const rect = el.getBoundingClientRect()
      if (rect.height >= MIN_HEIGHT && rect.width >= MIN_WIDTH && isPotentialSectionElement(el)) allSemantic.add(el)
    })

    // ---- Step 2: Recursive unwrapper ----
    // If an element is too tall and has meaningful children, unwrap it
    const vh = window.innerHeight
    const finalSections: Element[] = []

    const tryAdd = (el: Element, depth: number) => {
      const rect = el.getBoundingClientRect()
      if (rect.height < MIN_HEIGHT || rect.width < MIN_WIDTH) return

      const tag = el.tagName.toLowerCase()
      if (!isPotentialSectionElement(el) && !HARD_SECTION_TAGS.has(tag)) return

      // Always keep nav, header, footer as-is
      if (HARD_SECTION_TAGS.has(tag)) {
        finalSections.push(el)
        return
      }

      const signal = getSignals(el)

      // Generic wrappers should unwrap into their dominant child instead of becoming a section.
      const dominantChild = getDominantChild(el)
      if (
        dominantChild &&
        depth < 5 &&
        !signal.hasBoundaryHint &&
        !HARD_SECTION_TAGS.has(tag) &&
        signal.childCount <= 2
      ) {
        tryAdd(dominantChild, depth + 1)
        return
      }

      // Keep repeated UI clusters as one section instead of splitting each item.
      if (signal.repeatedChildCluster && rect.height <= vh * 2.5 && (signal.headingCount > 0 || signal.childCount >= 3)) {
        finalSections.push(el)
        return
      }

      // If element is reasonably sized, keep it
      if (rect.height <= vh * MAX_SECTION_HEIGHT_RATIO) {
        finalSections.push(el)
        return
      }

      // Element is too tall - try to unwrap into children
      const validChildren = visibleChildren(el).filter(isPotentialSectionElement)

      if (validChildren.length >= 2 && depth < 4) {
        const avgHeight = validChildren.reduce((sum, child) => sum + child.getBoundingClientRect().height, 0) / validChildren.length
        if (avgHeight < 140 && signal.childCount >= 4) {
          finalSections.push(el)
          return
        }

        // Unwrap: recurse into children
        for (const child of validChildren) {
          tryAdd(child, depth + 1)
        }
      } else {
        // Can't meaningfully unwrap, keep as-is
        finalSections.push(el)
      }
    }

    // ---- Step 3: Start from body's direct children ----
    // First, process semantic elements
    for (const el of allSemantic) {
      // Skip if it's nested inside another semantic element we'll process
      let dominated = false
      for (const other of allSemantic) {
        if (other !== el && other.contains(el) && !['main'].includes(other.tagName.toLowerCase())) {
          dominated = true
          break
        }
      }
      if (!dominated && !['main'].includes(el.tagName.toLowerCase())) {
        tryAdd(el, 0)
      }
    }

    // Then process body direct children that aren't already covered
    for (const child of Array.from(document.body.children)) {
      const tag = child.tagName.toLowerCase()
      if (IGNORE_TAGS.has(tag)) continue

      // Skip only when an existing selection already covers this node.
      const alreadyCovered = finalSections.some(s => s === child || s.contains(child))
      if (alreadyCovered) continue

      tryAdd(child, 0)
    }

    // Also check <main> children directly
    const mainEl = document.querySelector('main')
    if (mainEl) {
      for (const child of Array.from(mainEl.children)) {
        const alreadyCovered = finalSections.some(s => s === child || s.contains(child))
        if (alreadyCovered) continue
        tryAdd(child, 0)
      }
    }

    // ---- Step 4: Deduplicate and sort ----
    const uniqueSections: Element[] = []
    const seen = new Set<Element>()
    for (const el of finalSections) {
      if (seen.has(el)) continue
      // Remove if fully contained by another stronger section
      const containedByOther = finalSections.some(o => (
        o !== el &&
        o.contains(el) &&
        computeSectionScore(o) >= computeSectionScore(el)
      ))
      if (containedByOther) continue
      seen.add(el)
      uniqueSections.push(el)
    }

    uniqueSections.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)

    const totalSections = uniqueSections.length

    // ---- Helper: DOM path ----
    const getDomPath = (el: Element): string => {
      const parts: string[] = []
      let current: Element | null = el
      while (current && current !== document.body) {
        const tag = current.tagName.toLowerCase()
        const parent: Element | null = current.parentElement
        if (parent) {
          const curTag = current.tagName
          const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === curTag)
          if (siblings.length > 1) {
            const idx = siblings.indexOf(current) + 1
            parts.unshift(`${tag}:nth-of-type(${idx})`)
          } else {
            parts.unshift(tag)
          }
        } else {
          parts.unshift(tag)
        }
        current = parent
      }
      return 'body > ' + parts.join(' > ')
    }

    // ---- Helper: Repeated child patterns ----
    const detectRepeatedPattern = (el: Element): string | null => {
      const children = Array.from(el.children)
      if (children.length < 3) return null
      const tagPatterns: string[] = children.map(c => {
        const tag = c.tagName.toLowerCase()
        const cls = Array.from(c.classList).sort().join('.')
        return cls ? `${tag}.${cls}` : tag
      })
      const counts: Record<string, number> = {}
      for (const p of tagPatterns) counts[p] = (counts[p] || 0) + 1
      const [pattern, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
      if (count >= 3) return `${pattern} x${count}`
      return null
    }

    const copyAttrs = (from: Element, to: Element) => {
      for (const attr of Array.from(from.attributes)) {
        const name = attr.name.toLowerCase()
        const value = attr.value
        if (name.startsWith('on')) continue
        if ((name === 'href' || name === 'src') && value.trim().toLowerCase().startsWith('javascript:')) continue
        to.setAttribute(attr.name, attr.value)
      }
    }

    const createShallowClone = (el: Element, doc: Document): Element => {
      const clone = doc.createElement(el.tagName)
      copyAttrs(el, clone)
      return clone
    }

    const createPlaceholderClone = (el: Element, doc: Document): Element => {
      const clone = createShallowClone(el, doc)
      const styleAttr = clone.getAttribute('style')
      const hiddenStyle = `${styleAttr ? `${styleAttr};` : ''}display:none !important;`
      clone.setAttribute('style', hiddenStyle)
      clone.setAttribute('aria-hidden', 'true')
      clone.setAttribute('data-pc-placeholder', 'true')
      return clone
    }

    const buildInlineStyle = (el: Element) => {
      const cs = window.getComputedStyle(el)
      const parts: string[] = []
      for (let i = 0; i < cs.length; i++) {
        const prop = cs[i]
        const value = cs.getPropertyValue(prop)
        if (!value) continue
        parts.push(`${prop}:${value};`)
      }
      return parts.join('')
    }

    const cloneResolvedTree = (el: Element, doc: Document): Element => {
      const clone = doc.createElement(el.tagName)
      copyAttrs(el, clone)

      const styleText = buildInlineStyle(el)
      if (styleText) clone.setAttribute('style', styleText)

      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          clone.appendChild(doc.createTextNode(child.textContent || ''))
          continue
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue
        const tag = (child as Element).tagName.toLowerCase()
        if (['script', 'noscript', 'iframe', 'object', 'embed', 'applet'].includes(tag)) continue
        clone.appendChild(cloneResolvedTree(child as Element, doc))
      }

      return clone
    }

    const buildPreviewHTML = (target: Element): string => {
      const previewDoc = document.implementation.createHTMLDocument(document.title || '')
      previewDoc.head.innerHTML = ''
      previewDoc.body.innerHTML = ''
      copyAttrs(document.documentElement, previewDoc.documentElement)
      copyAttrs(document.body, previewDoc.body)

      const chain: Element[] = []
      let current: Element | null = target
      while (current && current !== document.body) {
        chain.unshift(current)
        current = current.parentElement
      }

      let previewParent: Element = previewDoc.body
      let originalParent: Element = document.body

      for (let depth = 0; depth < chain.length; depth++) {
        const pathNode = chain[depth]
        const siblings = Array.from(originalParent.children).filter(child => {
          const tag = child.tagName.toLowerCase()
          return !['script', 'noscript'].includes(tag)
        })

        for (const sibling of siblings) {
          if (sibling === pathNode) {
            const clone = depth === chain.length - 1
              ? cloneResolvedTree(pathNode, previewDoc)
              : createShallowClone(pathNode, previewDoc)
            previewParent.appendChild(clone)
            previewParent = clone
          } else {
            previewParent.appendChild(createPlaceholderClone(sibling, previewDoc))
          }
        }

        originalParent = pathNode
      }

      return `<!DOCTYPE html>\n${previewDoc.documentElement.outerHTML}`
    }

    // ---- Step 5: Extract features ----
    return uniqueSections.map((el, index) => {
      const rect = el.getBoundingClientRect()
      const cs = window.getComputedStyle(el)

      const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6')
      const links = el.querySelectorAll('a')
      const buttons = el.querySelectorAll('button, a[href], input[type="submit"], .btn, [class*="button"], [class*="btn"]')
      const forms = el.querySelectorAll('form')
      const images = el.querySelectorAll('img, picture, [style*="background-image"]')
      const cards = el.querySelectorAll('[class*="card"], [class*="item"], [class*="col-"], [class*="grid-"] > *')
      const listItems = el.querySelectorAll('li')
      const videos = el.querySelectorAll('video, iframe[src*="youtube"], iframe[src*="vimeo"]')
      const svgs = el.querySelectorAll('svg')

      const imageSources = Array.from(el.querySelectorAll('img')).map(img => img.src).filter(Boolean).slice(0, 10)
      const headingTexts = Array.from(headings).map(h => (h.textContent || '').trim()).filter(Boolean).slice(0, 5)

      const classTokens: string[] = (el.className || '').toString().split(/\s+/).filter(Boolean)
      const idTokens = el.id ? [el.id] : []
      for (const child of Array.from(el.children).slice(0, 20)) {
        const childClasses = (child.className || '').toString().split(/\s+/).filter(Boolean)
        classTokens.push(...childClasses)
      }

      return {
        index,
        tagName: el.tagName,
        outerHTML: el.outerHTML,
        previewHTML: buildPreviewHTML(el),
        textContent: (el.textContent || '').slice(0, 3000),
        domPath: getDomPath(el),
        boundingBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        computedStyles: {
          backgroundColor: cs.backgroundColor,
          backgroundImage: cs.backgroundImage,
          fontSize: cs.fontSize,
          fontFamily: cs.fontFamily,
          padding: cs.padding,
          display: cs.display,
          position: cs.position,
          textAlign: cs.textAlign,
          color: cs.color
        },
        features: {
          headingCount: headings.length,
          headingTexts,
          linkCount: links.length,
          buttonCount: buttons.length,
          formCount: forms.length,
          imageCount: images.length,
          imageSources,
          cardCount: cards.length,
          childCount: el.children.length,
          listItemCount: listItems.length,
          hasVideo: videos.length > 0,
          hasSvg: svgs.length > 0,
          textLength: (el.textContent || '').length,
          positionRatio: index / Math.max(totalSections - 1, 1),
          repeatedChildPattern: detectRepeatedPattern(el)
        },
        classTokens: [...new Set(classTokens)].slice(0, 50),
        idTokens
      }
    })
  })
}

/**
 * Take a QA screenshot of a section by scrolling to it.
 * Uses a timeout to prevent hangs.
 */
export async function screenshotSection(page: Page, bbox: { x: number; y: number; width: number; height: number }): Promise<Buffer | null> {
  try {
    // Scroll to section position first
    await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, bbox.y - 50))
    await new Promise(r => setTimeout(r, 200))

    const result = await Promise.race([
      page.screenshot({
        clip: {
          x: Math.max(0, bbox.x),
          y: Math.max(0, bbox.y),
          width: Math.min(bbox.width, 1440),
          height: Math.min(bbox.height, 2000)
        }
      }),
      new Promise<null>(r => setTimeout(() => r(null), 5000))
    ])
    return result as Buffer | null
  } catch {
    return null
  }
}
