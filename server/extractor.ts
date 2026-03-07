import puppeteer from 'puppeteer'
import { v4 as uuid } from 'uuid'

interface BlockType {
  type: string
  confidence: number
}

interface RawSection {
  tagName: string
  outerHTML: string
  textContent: string
  boundingBox: { top: number; left: number; width: number; height: number }
  computedStyles: Record<string, string>
  hasImages: boolean
  hasCTA: boolean
  hasForm: boolean
  headingCount: number
  linkCount: number
  cardCount: number
  childCount: number
  classNames: string
  id: string
}

function classifySection(section: RawSection, index: number, total: number): BlockType {
  const text = section.textContent.toLowerCase()
  const cls = section.classNames.toLowerCase()
  const id = section.id.toLowerCase()
  const tag = section.tagName.toLowerCase()
  const pos = index / Math.max(total - 1, 1)

  // Navigation
  if (tag === 'nav' || cls.includes('nav') || id.includes('nav')) {
    return { type: 'navigation', confidence: 0.95 }
  }
  if (tag === 'header' || cls.includes('header') || id.includes('header')) {
    if (section.linkCount >= 3) return { type: 'navigation', confidence: 0.9 }
  }

  // Footer
  if (tag === 'footer' || cls.includes('footer') || id.includes('footer')) {
    return { type: 'footer', confidence: 0.95 }
  }
  if (pos > 0.85 && section.linkCount > 5) {
    return { type: 'footer', confidence: 0.7 }
  }

  // Hero - typically first large section
  if (pos < 0.25 && (
    cls.includes('hero') || id.includes('hero') ||
    cls.includes('jumbotron') || cls.includes('banner') ||
    cls.includes('main-visual') || cls.includes('mainvisual') ||
    cls.includes('mv') || cls.includes('kv') ||
    cls.includes('fv') || cls.includes('firstview')
  )) {
    return { type: 'hero', confidence: 0.95 }
  }
  if (pos < 0.2 && section.boundingBox.height > 300 && section.hasCTA) {
    return { type: 'hero', confidence: 0.8 }
  }
  if (pos < 0.15 && section.headingCount >= 1 && section.hasImages) {
    return { type: 'hero', confidence: 0.7 }
  }

  // FAQ
  if (cls.includes('faq') || id.includes('faq') ||
    text.includes('よくある質問') || text.includes('faq') ||
    text.includes('frequently asked')) {
    return { type: 'faq', confidence: 0.9 }
  }

  // Pricing
  if (cls.includes('pricing') || id.includes('pricing') ||
    cls.includes('plan') || id.includes('plan') ||
    text.includes('料金') || text.includes('プラン') || text.includes('pricing')) {
    if (section.cardCount >= 2) return { type: 'pricing', confidence: 0.9 }
    return { type: 'pricing', confidence: 0.75 }
  }

  // Contact / Form
  if (section.hasForm || cls.includes('contact') || id.includes('contact') ||
    text.includes('お問い合わせ') || text.includes('contact')) {
    return { type: 'contact', confidence: 0.85 }
  }

  // Testimonial
  if (cls.includes('testimonial') || cls.includes('voice') || cls.includes('review') ||
    id.includes('testimonial') || id.includes('voice') ||
    text.includes('お客様の声') || text.includes('testimonial') ||
    text.includes('導入事例') || text.includes('お客さまの声')) {
    return { type: 'testimonial', confidence: 0.85 }
  }

  // Logo cloud / Trust
  if (cls.includes('logo') || cls.includes('client') || cls.includes('partner') ||
    cls.includes('trust') || id.includes('logo') ||
    text.includes('導入企業') || text.includes('取引先')) {
    if (section.hasImages) return { type: 'logo-cloud', confidence: 0.8 }
  }

  // Stats
  if (cls.includes('number') || cls.includes('stat') || cls.includes('counter') ||
    cls.includes('achievement') || text.includes('実績')) {
    return { type: 'stats', confidence: 0.75 }
  }

  // CTA
  if (cls.includes('cta') || id.includes('cta') ||
    (section.hasCTA && section.headingCount <= 2 && section.childCount < 10)) {
    return { type: 'cta', confidence: 0.8 }
  }

  // Feature
  if (cls.includes('feature') || cls.includes('service') || cls.includes('merit') ||
    cls.includes('benefit') || id.includes('feature') || id.includes('service') ||
    text.includes('特徴') || text.includes('サービス') || text.includes('feature')) {
    if (section.cardCount >= 2) return { type: 'feature', confidence: 0.85 }
    return { type: 'feature', confidence: 0.7 }
  }

  // Gallery
  if (cls.includes('gallery') || cls.includes('portfolio') || cls.includes('works') ||
    id.includes('gallery') || id.includes('works')) {
    return { type: 'gallery', confidence: 0.8 }
  }

  // Cards-based feature detection
  if (section.cardCount >= 3) {
    return { type: 'feature', confidence: 0.6 }
  }

  // Generic content
  if (section.headingCount >= 1 && section.textContent.length > 100) {
    return { type: 'content', confidence: 0.5 }
  }

  return { type: 'unknown', confidence: 0.3 }
}

export async function extractParts(url: string) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
    // Wait for lazy-loaded content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await new Promise(r => setTimeout(r, 1500))
    await page.evaluate(() => window.scrollTo(0, 0))
    await new Promise(r => setTimeout(r, 500))

    const sections: RawSection[] = await page.evaluate(() => {
      const results: any[] = []
      // Strategy: find semantic elements first, then fall back to direct children of body
      const candidates = new Set<Element>()

      // Semantic elements
      document.querySelectorAll('header, nav, main, section, article, aside, footer').forEach(el => candidates.add(el))

      // Direct children of body that are block-level and substantial
      const body = document.body
      for (const child of Array.from(body.children)) {
        const tag = child.tagName.toLowerCase()
        if (['script', 'style', 'link', 'meta', 'noscript', 'br', 'hr'].includes(tag)) continue
        const rect = child.getBoundingClientRect()
        if (rect.height > 50 && rect.width > 200) {
          // Check if this element or a parent is already in candidates
          let dominated = false
          for (const c of candidates) {
            if (c.contains(child) && c !== child) { dominated = true; break }
          }
          if (!dominated) candidates.add(child)
        }
      }

      // Remove sections that are ancestors of other sections (keep the more specific ones)
      const candidateArr = Array.from(candidates)
      const filtered = candidateArr.filter(el => {
        // Keep if no other candidate is a child of this element
        // Exception: keep nav/header/footer even if they contain other candidates
        const tag = el.tagName.toLowerCase()
        if (['nav', 'header', 'footer'].includes(tag)) return true
        const hasChildCandidate = candidateArr.some(other => other !== el && el.contains(other))
        // If this element has child candidates and is very large, skip it (prefer children)
        if (hasChildCandidate) {
          const rect = el.getBoundingClientRect()
          if (rect.height > window.innerHeight * 1.5) return false
        }
        return true
      })

      for (const el of filtered) {
        const rect = el.getBoundingClientRect()
        if (rect.height < 30) continue

        const links = el.querySelectorAll('a')
        const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6')
        const images = el.querySelectorAll('img, svg, picture, video')
        const buttons = el.querySelectorAll('button, a[href], input[type="submit"], .btn, [class*="button"], [class*="btn"]')
        const forms = el.querySelectorAll('form')
        const cards = el.querySelectorAll('[class*="card"], [class*="item"], [class*="col-"], [class*="grid-"] > *')

        // Get computed background
        const cs = window.getComputedStyle(el)

        results.push({
          tagName: el.tagName,
          outerHTML: el.outerHTML,
          textContent: (el.textContent || '').slice(0, 2000),
          boundingBox: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          computedStyles: {
            backgroundColor: cs.backgroundColor,
            backgroundImage: cs.backgroundImage,
            padding: cs.padding,
            display: cs.display,
            position: cs.position
          },
          hasImages: images.length > 0,
          hasCTA: buttons.length > 0,
          hasForm: forms.length > 0,
          headingCount: headings.length,
          linkCount: links.length,
          cardCount: cards.length,
          childCount: el.children.length,
          classNames: el.className || '',
          id: el.id || ''
        })
      }

      return results
    })

    // Get full page styles for block rendering
    const pageStyles = await page.evaluate(() => {
      const styles: string[] = []
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            styles.push(rule.cssText)
          }
        } catch {
          // Cross-origin stylesheets
        }
      }
      // Also get linked stylesheet URLs
      const linkTags = document.querySelectorAll('link[rel="stylesheet"]')
      const hrefs = Array.from(linkTags).map(l => (l as HTMLLinkElement).href)
      return { inlineCSS: styles.join('\n'), stylesheetUrls: hrefs }
    })

    // Take screenshots of each section
    const parts = []
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]
      const classification = classifySection(section, i, sections.length)

      let thumbnail: string | undefined
      try {
        // Find the element on page and screenshot it
        const elementHandle = await page.evaluateHandle((idx: number) => {
          const candidates = new Set<Element>()
          document.querySelectorAll('header, nav, main, section, article, aside, footer').forEach(el => candidates.add(el))
          const body = document.body
          for (const child of Array.from(body.children)) {
            const tag = child.tagName.toLowerCase()
            if (['script', 'style', 'link', 'meta', 'noscript', 'br', 'hr'].includes(tag)) continue
            const rect = child.getBoundingClientRect()
            if (rect.height > 50 && rect.width > 200) {
              let dominated = false
              for (const c of candidates) {
                if (c.contains(child) && c !== child) { dominated = true; break }
              }
              if (!dominated) candidates.add(child)
            }
          }
          const candidateArr = Array.from(candidates)
          const filtered = candidateArr.filter(el => {
            const tag = el.tagName.toLowerCase()
            if (['nav', 'header', 'footer'].includes(tag)) return true
            const hasChildCandidate = candidateArr.some(other => other !== el && el.contains(other))
            if (hasChildCandidate) {
              const rect = el.getBoundingClientRect()
              if (rect.height > window.innerHeight * 1.5) return false
            }
            return true
          }).filter(el => {
            const rect = el.getBoundingClientRect()
            return rect.height >= 30
          })
          return filtered[idx] || null
        }, i)

        if (elementHandle) {
          const el = elementHandle.asElement()
          if (el) {
            // Scroll element into view first
            await el.scrollIntoView()
            await new Promise(r => setTimeout(r, 200))
            const screenshotBuffer = await el.screenshot({ encoding: 'base64' }) as string
            thumbnail = `data:image/png;base64,${screenshotBuffer}`
          }
        }
      } catch (e) {
        // Screenshot failed, continue without thumbnail
      }

      // Strip third-party images: replace <img> with placeholder, remove background-image
      let cleanHtml = section.outerHTML
        // Replace <img> tags with a placeholder div preserving layout
        .replace(/<img\b[^>]*>/gi, '<div class="pc-img-placeholder" style="background:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:80px;color:#94a3b8;font-size:13px;border-radius:4px;">IMAGE</div>')
        // Remove <picture> and <video> elements entirely, leave placeholder
        .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '<div class="pc-img-placeholder" style="background:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:80px;color:#94a3b8;font-size:13px;border-radius:4px;">IMAGE</div>')
        .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, '<div class="pc-img-placeholder" style="background:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:80px;color:#94a3b8;font-size:13px;border-radius:4px;">VIDEO</div>')
        // Remove inline background-image styles
        .replace(/background-image\s*:\s*url\([^)]*\)\s*;?/gi, '')
        // Remove SVG inline images (data URIs are fine to keep for icons)

      // Convert relative URLs to absolute in remaining HTML (href, action etc.)
      const baseUrl = new URL(url)
      const origin = baseUrl.origin
      let fixedHtml = cleanHtml
        .replace(/(href|action)=["'](?!https?:\/\/|data:|#|mailto:|tel:|javascript:)(\/?)([^"']*?)["']/gi,
          (match, attr, slash, path) => {
            const absUrl = slash ? `${origin}/${path}` : `${origin}${baseUrl.pathname.replace(/[^/]*$/, '')}${path}`
            return `${attr}="${absUrl}"`
          })

      parts.push({
        id: uuid(),
        type: classification.type,
        confidence: classification.confidence,
        html: fixedHtml,
        css: pageStyles.inlineCSS.slice(0, 50000),
        stylesheetUrls: pageStyles.stylesheetUrls,
        textContent: section.textContent.slice(0, 500),
        tagName: section.tagName,
        position: section.boundingBox,
        thumbnail,
        genre: '',
        tags: [] as string[],
        meta: {
          hasImages: section.hasImages,
          hasCTA: section.hasCTA,
          hasForm: section.hasForm,
          headingCount: section.headingCount,
          linkCount: section.linkCount,
          cardCount: section.cardCount
        },
        sourceUrl: url
      })
    }

    return parts
  } finally {
    await browser.close()
  }
}
