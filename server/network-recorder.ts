/**
 * Network Recorder v2
 * Collect all CSS from a loaded page using page.evaluate.
 * Also records asset URLs for provenance.
 */
import type { Page } from 'puppeteer'

export interface AssetRecord {
  url: string
  assetType: 'stylesheet' | 'font' | 'image' | 'script' | 'other'
  contentType: string
  statusCode: number
  sizeBytes: number
}

export interface NetworkLog {
  assets: AssetRecord[]
  cssBundle: string
}

/**
 * Collect all CSS from the page after it has fully loaded.
 * Strategy:
 * 1. Read cssRules from same-origin stylesheets via document.styleSheets
 * 2. Fetch cross-origin stylesheet hrefs via fetch() in page context
 * 3. Collect inline <style> tag contents
 */
export async function collectPageCSS(page: Page): Promise<string> {
  const css = await page.evaluate(async () => {
    if (typeof (globalThis as any).__name === 'undefined') (globalThis as any).__name = (t: any) => t

    const parts: string[] = []
    const fetchedUrls = new Set<string>()

    // 1. Try to read cssRules from each stylesheet
    for (const sheet of document.styleSheets) {
      const href = sheet.href || ''
      try {
        // Same-origin sheets: read cssRules directly
        let sheetCSS = ''
        for (const rule of sheet.cssRules) {
          sheetCSS += rule.cssText + '\n'
        }
        if (sheetCSS) {
          parts.push(`/* sheet: ${href || 'inline'} */\n${sheetCSS}`)
          if (href) fetchedUrls.add(href)
        }
      } catch {
        // Cross-origin: will fetch below
      }
    }

    // 2. Fetch cross-origin stylesheets
    const linkHrefs = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .map(l => (l as HTMLLinkElement).href)
      .filter(h => h && !fetchedUrls.has(h))

    for (const href of linkHrefs) {
      try {
        const res = await fetch(href, { mode: 'cors', credentials: 'omit' })
        if (res.ok) {
          const text = await res.text()
          parts.push(`/* fetched: ${href} */\n${text}`)
        }
      } catch {
        // Some sheets may block CORS fetch too, skip
      }
    }

    // 3. Inline <style> tags
    const inlineStyles = Array.from(document.querySelectorAll('style'))
      .map(s => s.textContent || '')
      .filter(t => t.length > 0)

    for (const style of inlineStyles) {
      parts.push(`/* inline style */\n${style}`)
    }

    return parts.join('\n\n')
  })

  return css
}

/**
 * Record all asset URLs from the page (images, fonts, scripts, etc.)
 */
export async function collectAssetRecords(page: Page): Promise<AssetRecord[]> {
  return page.evaluate(() => {
    if (typeof (globalThis as any).__name === 'undefined') (globalThis as any).__name = (t: any) => t

    const assets: any[] = []

    // Stylesheets
    document.querySelectorAll('link[rel="stylesheet"]').forEach(el => {
      const href = (el as HTMLLinkElement).href
      if (href) assets.push({ url: href, assetType: 'stylesheet', contentType: 'text/css', statusCode: 200, sizeBytes: 0 })
    })

    // Images
    document.querySelectorAll('img').forEach(el => {
      const src = (el as HTMLImageElement).src
      if (src && !src.startsWith('data:')) assets.push({ url: src, assetType: 'image', contentType: 'image/*', statusCode: 200, sizeBytes: 0 })
    })

    // Fonts (from @font-face in computed styles - approximation via link preloads)
    document.querySelectorAll('link[rel="preload"][as="font"], link[rel="prefetch"][as="font"]').forEach(el => {
      const href = (el as HTMLLinkElement).href
      if (href) assets.push({ url: href, assetType: 'font', contentType: 'font/*', statusCode: 200, sizeBytes: 0 })
    })

    // Scripts
    document.querySelectorAll('script[src]').forEach(el => {
      const src = (el as HTMLScriptElement).src
      if (src) assets.push({ url: src, assetType: 'script', contentType: 'application/javascript', statusCode: 200, sizeBytes: 0 })
    })

    return assets
  })
}

/**
 * Fix relative URLs in CSS to absolute
 */
export function fixCSSUrls(css: string, pageOrigin: string): string {
  return css.replace(
    /url\(\s*(['"]?)(?!data:|https?:|\/\/)([^)'"]+)\1\s*\)/gi,
    (_, q, path) => {
      const resolved = path.startsWith('/')
        ? `${pageOrigin}${path}`
        : `${pageOrigin}/${path}`
      return `url(${q}${resolved}${q})`
    }
  )
}
