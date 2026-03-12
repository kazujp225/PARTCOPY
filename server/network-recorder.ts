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

export interface CSSChunk {
  sourceUrl: string
  baseUrl: string
  cssText: string
  scope: 'document' | 'shadow'
}

/**
 * Collect all CSS from the page after it has fully loaded.
 * Strategy:
 * 1. Read cssRules from same-origin stylesheets via document.styleSheets
 * 2. Fetch cross-origin stylesheet hrefs via fetch() in page context
 * 3. Collect inline <style> tag contents
 */
export async function collectCSSChunks(page: Page): Promise<CSSChunk[]> {
  return page.evaluate(async () => {
    if (typeof (globalThis as any).__name === 'undefined') (globalThis as any).__name = (t: any) => t

    const chunks: CSSChunk[] = []
    const seen = new Set<string>()

    const pushChunk = (chunk: CSSChunk) => {
      const cssText = chunk.cssText.trim()
      if (!cssText) return
      const key = `${chunk.scope}|${chunk.sourceUrl}|${cssText.slice(0, 200)}`
      if (seen.has(key)) return
      seen.add(key)
      chunks.push({ ...chunk, cssText })
    }

    const readSheet = (sheet: CSSStyleSheet, scope: 'document' | 'shadow') => {
      const href = sheet.href || ''
      try {
        let cssText = ''
        for (const rule of Array.from(sheet.cssRules)) {
          cssText += `${rule.cssText}\n`
        }
        pushChunk({
          sourceUrl: href || 'inline',
          baseUrl: href || document.baseURI,
          cssText,
          scope
        })
        return true
      } catch {
        return false
      }
    }

    const fetchCrossOriginSheet = async (href: string, scope: 'document' | 'shadow') => {
      try {
        const res = await fetch(href, { mode: 'cors', credentials: 'omit' })
        if (!res.ok) return
        const text = await res.text()
        pushChunk({
          sourceUrl: href,
          baseUrl: href,
          cssText: text,
          scope
        })
      } catch {
        // Ignore inaccessible cross-origin CSS.
      }
    }

    const collectRootSheets = async (root: Document | ShadowRoot, scope: 'document' | 'shadow') => {
      const unreadableHrefs: string[] = []

      for (const sheet of Array.from(root.styleSheets || [])) {
        const readable = readSheet(sheet as CSSStyleSheet, scope)
        if (!readable && sheet.href) unreadableHrefs.push(sheet.href)
      }

      if ('adoptedStyleSheets' in root) {
        for (const sheet of Array.from((root as Document | ShadowRoot).adoptedStyleSheets || [])) {
          readSheet(sheet as CSSStyleSheet, scope)
        }
      }

      for (const href of unreadableHrefs) {
        await fetchCrossOriginSheet(href, scope)
      }
    }

    await collectRootSheets(document, 'document')

    const shadowHosts = Array.from(document.querySelectorAll('*')).filter(el => Boolean((el as HTMLElement).shadowRoot))
    for (const host of shadowHosts) {
      const shadowRoot = (host as HTMLElement).shadowRoot
      if (!shadowRoot) continue
      await collectRootSheets(shadowRoot, 'shadow')
    }

    return chunks
  })
}

export async function collectPageCSS(page: Page): Promise<string> {
  const chunks = await collectCSSChunks(page)
  return chunks.map(chunk => `/* ${chunk.scope}: ${chunk.sourceUrl} */\n${chunk.cssText}`).join('\n\n')
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

export function resolveCSSUrls(css: string, baseUrl: string): string {
  const rewritePath = (rawPath: string) => {
    const trimmed = rawPath.trim()
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('http') || trimmed.startsWith('//') || trimmed.startsWith('#')) {
      return trimmed
    }
    try {
      return new URL(trimmed, baseUrl).href
    } catch {
      return trimmed
    }
  }

  let next = css.replace(
    /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
    (_match, q, rawPath) => `url(${q}${rewritePath(rawPath)}${q})`
  )

  next = next.replace(
    /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1(?:\s*\))?/gi,
    (_match, q, rawPath) => `@import url(${q}${rewritePath(rawPath)}${q})`
  )

  return next
}
