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

    // ---- Step 1: Collect semantic candidates ----
    const semanticTags = new Set(['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'])
    const allSemantic = new Set<Element>()
    document.querySelectorAll('header, nav, main, section, article, aside, footer').forEach(el => {
      const rect = el.getBoundingClientRect()
      if (rect.height >= MIN_HEIGHT && rect.width >= MIN_WIDTH) allSemantic.add(el)
    })

    // ---- Step 2: Recursive unwrapper ----
    // If an element is too tall and has meaningful children, unwrap it
    const vh = window.innerHeight
    const finalSections: Element[] = []

    const tryAdd = (el: Element, depth: number) => {
      const rect = el.getBoundingClientRect()
      if (rect.height < MIN_HEIGHT || rect.width < MIN_WIDTH) return

      const tag = el.tagName.toLowerCase()

      // Always keep nav, header, footer as-is
      if (['nav', 'header', 'footer'].includes(tag)) {
        finalSections.push(el)
        return
      }

      // If element is reasonably sized, keep it
      if (rect.height <= vh * MAX_SECTION_HEIGHT_RATIO) {
        finalSections.push(el)
        return
      }

      // Element is too tall - try to unwrap into children
      const validChildren = Array.from(el.children).filter(c => {
        const ct = c.tagName.toLowerCase()
        if (['script', 'style', 'link', 'meta', 'noscript', 'br', 'hr'].includes(ct)) return false
        const cr = c.getBoundingClientRect()
        return cr.height >= MIN_HEIGHT && cr.width >= MIN_WIDTH
      })

      if (validChildren.length >= 2 && depth < 4) {
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
      if (['script', 'style', 'link', 'meta', 'noscript', 'br', 'hr', 'svg'].includes(tag)) continue

      // Skip if already in finalSections or contained by something in finalSections
      const alreadyCovered = finalSections.some(s => s === child || s.contains(child) || child.contains(s))
      if (alreadyCovered) continue

      tryAdd(child, 0)
    }

    // Also check <main> children directly
    const mainEl = document.querySelector('main')
    if (mainEl) {
      for (const child of Array.from(mainEl.children)) {
        const alreadyCovered = finalSections.some(s => s === child || s.contains(child) || child.contains(s))
        if (alreadyCovered) continue
        tryAdd(child, 0)
      }
    }

    // ---- Step 4: Deduplicate and sort ----
    const uniqueSections: Element[] = []
    const seen = new Set<Element>()
    for (const el of finalSections) {
      if (seen.has(el)) continue
      // Remove if fully contained by another section
      const containedByOther = finalSections.some(o => o !== el && o.contains(el))
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
