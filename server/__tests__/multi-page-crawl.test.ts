/**
 * Multi-Page Crawl Feature - Verification Tests
 *
 * Tests for the multi-page crawling feature where a single URL submission
 * crawls the target page AND linked pages on the same domain (max 5 pages).
 *
 * These tests validate the pure-logic helpers that the feature introduces:
 *   - Link collection from HTML (same-domain filtering)
 *   - Auth URL detection and skipping
 *   - Max page limit enforcement
 *   - Duplicate URL avoidance
 *   - URL normalization for dedup
 *
 * NOTE: These tests do NOT depend on Puppeteer, Supabase, or the running server.
 * They test standalone logic functions that should be importable from the worker
 * or a dedicated utility module.
 */
import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Inline reference implementations of the expected helper functions.
//
// The actual implementation will live in worker.ts or a helper module.
// These reference functions define the EXPECTED behavior so the implementing
// agent can run these tests against their code.
//
// Once the feature is merged, replace these with imports from the real module:
//   import { collectSameDomainLinks, isAuthUrl, normalizeUrl, ... } from '../worker.js'
// ---------------------------------------------------------------------------

/**
 * Extract same-domain links from an HTML string.
 * Returns an array of absolute URLs on the same domain as `baseUrl`.
 * Filters out:
 *   - Different-domain links
 *   - Fragment-only links (#...)
 *   - mailto:, tel:, javascript: links
 *   - Data URLs
 *   - Links to non-HTML resources (images, PDFs, zips, etc.)
 */
function collectSameDomainLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl)
  const baseOrigin = base.origin // includes protocol + hostname + port

  // Match href="..." in anchor tags
  const hrefRegex = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi
  const urls = new Set<string>()
  let match: RegExpExecArray | null

  while ((match = hrefRegex.exec(html)) !== null) {
    const raw = match[1].trim()

    // Skip non-navigable schemes
    if (/^(mailto:|tel:|javascript:|data:)/i.test(raw)) continue
    // Skip fragment-only
    if (raw.startsWith('#')) continue

    try {
      const resolved = new URL(raw, baseUrl)
      // Same origin check (hostname + port must match)
      if (resolved.origin !== baseOrigin) continue
      // Skip non-HTML extensions
      const ext = resolved.pathname.split('.').pop()?.toLowerCase()
      if (ext && /^(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tar|mp4|mp3|avi|mov|woff2?|ttf|eot|css|js)$/.test(ext)) continue

      // Normalize: strip fragment, keep path+query
      resolved.hash = ''
      urls.add(resolved.href)
    } catch {
      // Invalid URL, skip
    }
  }

  // Remove the base URL itself
  urls.delete(new URL(baseUrl).href)
  // Also remove with/without trailing slash variant
  const baseNormalized = new URL(baseUrl)
  baseNormalized.hash = ''
  urls.delete(baseNormalized.href)
  if (baseNormalized.pathname.endsWith('/')) {
    const withoutSlash = new URL(baseNormalized.href)
    withoutSlash.pathname = withoutSlash.pathname.replace(/\/$/, '') || '/'
    urls.delete(withoutSlash.href)
  } else {
    const withSlash = new URL(baseNormalized.href)
    withSlash.pathname += '/'
    urls.delete(withSlash.href)
  }

  return [...urls]
}

/**
 * Determine if a URL looks like it requires authentication.
 * Checks for common auth-related path segments.
 */
function isAuthUrl(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase()
  const authPatterns = [
    '/login',
    '/signin',
    '/sign-in',
    '/sign_in',
    '/signup',
    '/sign-up',
    '/sign_up',
    '/register',
    '/auth',
    '/oauth',
    '/sso',
    '/logout',
    '/signout',
    '/sign-out',
    '/password',
    '/forgot-password',
    '/reset-password',
    '/account/login',
    '/admin/login',
    '/dashboard/login',
    '/my-account',
    '/mypage',
    '/member',
  ]
  return authPatterns.some(pattern => path.includes(pattern))
}

/**
 * Determine if an HTTP status code indicates auth is required.
 */
function isAuthStatus(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403
}

/**
 * Determine if a redirect URL indicates a login redirect.
 */
function isLoginRedirect(requestedUrl: string, finalUrl: string): boolean {
  if (requestedUrl === finalUrl) return false
  return isAuthUrl(finalUrl)
}

/**
 * Select up to maxPages URLs from candidates, avoiding duplicates.
 * The seed URL always counts as page 1.
 */
function selectPagesToVisit(
  seedUrl: string,
  candidates: string[],
  maxPages: number
): string[] {
  const seen = new Set<string>()
  const normalizedSeed = normalizeUrlForDedup(seedUrl)
  seen.add(normalizedSeed)

  const result: string[] = []
  for (const url of candidates) {
    if (result.length >= maxPages - 1) break // -1 because seed counts as page 1
    const normalized = normalizeUrlForDedup(url)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(url)
  }
  return result
}

/**
 * Normalize a URL for deduplication purposes.
 * Strips fragment, trailing slash, lowercases hostname, sorts query params.
 */
function normalizeUrlForDedup(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    // Remove trailing slash (except for root "/")
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1)
    }
    // Sort query params for consistent comparison
    const params = new URLSearchParams(u.searchParams)
    const sorted = new URLSearchParams([...params.entries()].sort())
    u.search = sorted.toString()
    return u.href
  } catch {
    return url
  }
}


// ===========================================================================
// TEST SUITES
// ===========================================================================

describe('collectSameDomainLinks', () => {
  const BASE = 'https://example.com/page1'

  it('extracts same-domain absolute links', () => {
    const html = `
      <a href="https://example.com/about">About</a>
      <a href="https://example.com/services">Services</a>
    `
    const links = collectSameDomainLinks(html, BASE)
    expect(links).toContain('https://example.com/about')
    expect(links).toContain('https://example.com/services')
    expect(links).toHaveLength(2)
  })

  it('resolves relative links against the base URL', () => {
    const html = `
      <a href="/about">About</a>
      <a href="contact">Contact</a>
      <a href="../pricing">Pricing</a>
    `
    const links = collectSameDomainLinks(html, 'https://example.com/pages/home')
    expect(links).toContain('https://example.com/about')
    expect(links).toContain('https://example.com/pages/contact')
    expect(links).toContain('https://example.com/pricing')
  })

  it('filters out different-domain links', () => {
    const html = `
      <a href="https://example.com/about">About</a>
      <a href="https://other-site.com/page">Other</a>
      <a href="https://sub.other.com/page">Sub</a>
    `
    const links = collectSameDomainLinks(html, BASE)
    expect(links).toContain('https://example.com/about')
    expect(links).not.toContain('https://other-site.com/page')
    expect(links).not.toContain('https://sub.other.com/page')
    expect(links).toHaveLength(1)
  })

  it('filters out mailto, tel, javascript, and data links', () => {
    const html = `
      <a href="mailto:info@example.com">Email</a>
      <a href="tel:+1234567890">Phone</a>
      <a href="javascript:void(0)">Click</a>
      <a href="data:text/html,<h1>hi</h1>">Data</a>
      <a href="https://example.com/real">Real</a>
    `
    const links = collectSameDomainLinks(html, BASE)
    expect(links).toEqual(['https://example.com/real'])
  })

  it('filters out fragment-only links', () => {
    const html = `
      <a href="#section1">Jump</a>
      <a href="#top">Top</a>
      <a href="https://example.com/about#team">About</a>
    `
    const links = collectSameDomainLinks(html, BASE)
    // The fragment-only ones should be excluded; the full URL with fragment is kept (fragment stripped)
    expect(links).toContain('https://example.com/about')
    expect(links).toHaveLength(1)
  })

  it('filters out non-HTML resource links', () => {
    const html = `
      <a href="https://example.com/doc.pdf">PDF</a>
      <a href="https://example.com/image.png">Image</a>
      <a href="https://example.com/archive.zip">Zip</a>
      <a href="https://example.com/style.css">CSS</a>
      <a href="https://example.com/script.js">JS</a>
      <a href="https://example.com/font.woff2">Font</a>
      <a href="https://example.com/video.mp4">Video</a>
      <a href="https://example.com/about">About</a>
    `
    const links = collectSameDomainLinks(html, BASE)
    expect(links).toEqual(['https://example.com/about'])
  })

  it('strips fragments from collected URLs', () => {
    const html = `
      <a href="https://example.com/about#team">About</a>
      <a href="https://example.com/about#history">About History</a>
    `
    const links = collectSameDomainLinks(html, BASE)
    // Both should resolve to the same URL after fragment removal
    expect(links).toContain('https://example.com/about')
    expect(links).toHaveLength(1)
  })

  it('excludes the base URL itself from results', () => {
    const html = `
      <a href="https://example.com/page1">Self</a>
      <a href="https://example.com/about">About</a>
    `
    const links = collectSameDomainLinks(html, BASE)
    expect(links).not.toContain('https://example.com/page1')
    expect(links).toContain('https://example.com/about')
  })

  it('handles base URL with trailing slash', () => {
    const html = `
      <a href="https://example.com/">Home</a>
      <a href="https://example.com">Home2</a>
      <a href="https://example.com/about">About</a>
    `
    const links = collectSameDomainLinks(html, 'https://example.com/')
    // Both variants of the home URL should be excluded
    expect(links).not.toContain('https://example.com/')
    expect(links).not.toContain('https://example.com')
    expect(links).toContain('https://example.com/about')
  })

  it('returns empty array when there are no links', () => {
    const html = '<div>No links here</div>'
    const links = collectSameDomainLinks(html, BASE)
    expect(links).toEqual([])
  })

  it('returns empty array when all links are external', () => {
    const html = `
      <a href="https://google.com">Google</a>
      <a href="https://twitter.com/user">Twitter</a>
    `
    const links = collectSameDomainLinks(html, BASE)
    expect(links).toEqual([])
  })

  it('handles HTML with query parameters in links', () => {
    const html = `
      <a href="https://example.com/search?q=test">Search</a>
      <a href="/products?category=shoes&sort=price">Products</a>
    `
    const links = collectSameDomainLinks(html, BASE)
    expect(links).toContain('https://example.com/search?q=test')
    expect(links).toContain('https://example.com/products?category=shoes&sort=price')
  })

  it('deduplicates links that resolve to the same URL', () => {
    const html = `
      <a href="https://example.com/about">Link 1</a>
      <a href="https://example.com/about">Link 2</a>
      <a href="/about">Link 3</a>
    `
    const links = collectSameDomainLinks(html, BASE)
    expect(links).toHaveLength(1)
    expect(links[0]).toBe('https://example.com/about')
  })
})

describe('isAuthUrl', () => {
  it('detects common login paths', () => {
    expect(isAuthUrl('https://example.com/login')).toBe(true)
    expect(isAuthUrl('https://example.com/signin')).toBe(true)
    expect(isAuthUrl('https://example.com/sign-in')).toBe(true)
    expect(isAuthUrl('https://example.com/sign_in')).toBe(true)
    expect(isAuthUrl('https://example.com/auth/callback')).toBe(true)
  })

  it('detects signup and registration paths', () => {
    expect(isAuthUrl('https://example.com/signup')).toBe(true)
    expect(isAuthUrl('https://example.com/sign-up')).toBe(true)
    expect(isAuthUrl('https://example.com/register')).toBe(true)
  })

  it('detects OAuth and SSO paths', () => {
    expect(isAuthUrl('https://example.com/oauth/authorize')).toBe(true)
    expect(isAuthUrl('https://example.com/sso/login')).toBe(true)
  })

  it('detects logout and password reset paths', () => {
    expect(isAuthUrl('https://example.com/logout')).toBe(true)
    expect(isAuthUrl('https://example.com/signout')).toBe(true)
    expect(isAuthUrl('https://example.com/forgot-password')).toBe(true)
    expect(isAuthUrl('https://example.com/reset-password')).toBe(true)
  })

  it('detects account/member area paths', () => {
    expect(isAuthUrl('https://example.com/mypage')).toBe(true)
    expect(isAuthUrl('https://example.com/my-account')).toBe(true)
    expect(isAuthUrl('https://example.com/member/dashboard')).toBe(true)
  })

  it('detects nested login paths', () => {
    expect(isAuthUrl('https://example.com/account/login')).toBe(true)
    expect(isAuthUrl('https://example.com/admin/login')).toBe(true)
    expect(isAuthUrl('https://example.com/dashboard/login')).toBe(true)
  })

  it('does NOT flag normal pages', () => {
    expect(isAuthUrl('https://example.com/')).toBe(false)
    expect(isAuthUrl('https://example.com/about')).toBe(false)
    expect(isAuthUrl('https://example.com/pricing')).toBe(false)
    // Note: A blog post like "/blog/how-to-login-guide" triggers a false positive
    // because it contains "login" as a substring. This is a known trade-off of
    // simple substring matching. The implementing agent should decide whether to
    // accept this or use stricter path-segment matching (e.g. /login/ or /login$).
    // For now we document it as a known false positive and do NOT assert on it.
    // expect(isAuthUrl('https://example.com/blog/how-to-login-guide')).toBe(??)
    expect(isAuthUrl('https://example.com/products')).toBe(false)
    expect(isAuthUrl('https://example.com/contact')).toBe(false)
  })

  it('is case insensitive for path matching', () => {
    expect(isAuthUrl('https://example.com/Login')).toBe(true)
    expect(isAuthUrl('https://example.com/SIGNIN')).toBe(true)
    expect(isAuthUrl('https://example.com/Auth/Callback')).toBe(true)
  })
})

describe('isAuthStatus', () => {
  it('returns true for 401 Unauthorized', () => {
    expect(isAuthStatus(401)).toBe(true)
  })

  it('returns true for 403 Forbidden', () => {
    expect(isAuthStatus(403)).toBe(true)
  })

  it('returns false for success codes', () => {
    expect(isAuthStatus(200)).toBe(false)
    expect(isAuthStatus(301)).toBe(false)
    expect(isAuthStatus(302)).toBe(false)
  })

  it('returns false for other error codes', () => {
    expect(isAuthStatus(404)).toBe(false)
    expect(isAuthStatus(500)).toBe(false)
    expect(isAuthStatus(429)).toBe(false)
  })
})

describe('isLoginRedirect', () => {
  it('detects redirect to login page', () => {
    expect(isLoginRedirect(
      'https://example.com/dashboard',
      'https://example.com/login?redirect=/dashboard'
    )).toBe(true)
  })

  it('detects redirect to auth endpoint', () => {
    expect(isLoginRedirect(
      'https://example.com/settings',
      'https://example.com/auth/signin'
    )).toBe(true)
  })

  it('returns false when URL did not change', () => {
    expect(isLoginRedirect(
      'https://example.com/about',
      'https://example.com/about'
    )).toBe(false)
  })

  it('returns false for non-auth redirects', () => {
    expect(isLoginRedirect(
      'https://example.com/old-page',
      'https://example.com/new-page'
    )).toBe(false)
  })

  it('returns false for www/non-www redirects', () => {
    expect(isLoginRedirect(
      'https://example.com/about',
      'https://www.example.com/about'
    )).toBe(false)
  })
})

describe('normalizeUrlForDedup', () => {
  it('strips fragments', () => {
    expect(normalizeUrlForDedup('https://example.com/about#team'))
      .toBe('https://example.com/about')
  })

  it('removes trailing slash (non-root)', () => {
    expect(normalizeUrlForDedup('https://example.com/about/'))
      .toBe('https://example.com/about')
  })

  it('preserves root path slash', () => {
    const result = normalizeUrlForDedup('https://example.com/')
    expect(result).toBe('https://example.com/')
  })

  it('lowercases hostname', () => {
    expect(normalizeUrlForDedup('https://EXAMPLE.COM/About'))
      .toBe('https://example.com/About')
  })

  it('sorts query parameters', () => {
    expect(normalizeUrlForDedup('https://example.com/search?b=2&a=1'))
      .toBe('https://example.com/search?a=1&b=2')
  })

  it('handles URL without query or fragment', () => {
    expect(normalizeUrlForDedup('https://example.com/page'))
      .toBe('https://example.com/page')
  })

  it('returns the input for invalid URLs', () => {
    expect(normalizeUrlForDedup('not-a-url')).toBe('not-a-url')
  })
})

describe('selectPagesToVisit', () => {
  const SEED = 'https://example.com/'
  const MAX_PAGES = 5

  it('selects up to maxPages - 1 candidates (seed counts as page 1)', () => {
    const candidates = [
      'https://example.com/about',
      'https://example.com/services',
      'https://example.com/pricing',
      'https://example.com/blog',
      'https://example.com/contact',
      'https://example.com/team',
    ]
    const selected = selectPagesToVisit(SEED, candidates, MAX_PAGES)
    expect(selected).toHaveLength(4) // 5 - 1 seed = 4 sub-pages
  })

  it('returns fewer than max when candidates are limited', () => {
    const candidates = [
      'https://example.com/about',
      'https://example.com/services',
    ]
    const selected = selectPagesToVisit(SEED, candidates, MAX_PAGES)
    expect(selected).toHaveLength(2)
  })

  it('deduplicates URLs using normalization', () => {
    const candidates = [
      'https://example.com/about',
      'https://example.com/about/', // trailing slash variant
      'https://example.com/about#team', // fragment variant
      'https://example.com/services',
    ]
    const selected = selectPagesToVisit(SEED, candidates, MAX_PAGES)
    // /about, /about/, /about#team should all deduplicate to one entry
    expect(selected).toHaveLength(2)
    expect(selected[0]).toBe('https://example.com/about')
    expect(selected[1]).toBe('https://example.com/services')
  })

  it('excludes URLs that normalize to the seed URL', () => {
    const candidates = [
      'https://example.com/', // same as seed
      'https://example.com', // same without trailing slash
      'https://example.com/#hero', // same with fragment
      'https://example.com/about',
    ]
    const selected = selectPagesToVisit(SEED, candidates, MAX_PAGES)
    expect(selected).toHaveLength(1)
    expect(selected[0]).toBe('https://example.com/about')
  })

  it('preserves order of candidates (first come, first selected)', () => {
    const candidates = [
      'https://example.com/z-page',
      'https://example.com/a-page',
      'https://example.com/m-page',
    ]
    const selected = selectPagesToVisit(SEED, candidates, MAX_PAGES)
    expect(selected).toEqual(candidates)
  })

  it('returns empty array when no valid candidates', () => {
    const selected = selectPagesToVisit(SEED, [], MAX_PAGES)
    expect(selected).toEqual([])
  })

  it('enforces maxPages=1 (seed only, no sub-pages)', () => {
    const candidates = ['https://example.com/about']
    const selected = selectPagesToVisit(SEED, candidates, 1)
    expect(selected).toEqual([])
  })

  it('handles maxPages=2 (seed + 1 sub-page)', () => {
    const candidates = [
      'https://example.com/about',
      'https://example.com/services',
    ]
    const selected = selectPagesToVisit(SEED, candidates, 2)
    expect(selected).toHaveLength(1)
    expect(selected[0]).toBe('https://example.com/about')
  })
})

describe('integration: link collection + auth filtering + page selection', () => {
  it('full pipeline: collect, filter auth, select top N', () => {
    const seedUrl = 'https://corp.example.co.jp/'
    const html = `
      <nav>
        <a href="/">Home</a>
        <a href="/about">About Us</a>
        <a href="/services">Services</a>
        <a href="/pricing">Pricing</a>
        <a href="/blog">Blog</a>
        <a href="/careers">Careers</a>
        <a href="/contact">Contact</a>
        <a href="/login">Login</a>
        <a href="/signup">Sign Up</a>
        <a href="/my-account">My Account</a>
        <a href="https://other-domain.com/page">External</a>
        <a href="/docs/guide.pdf">PDF Guide</a>
        <a href="mailto:info@corp.example.co.jp">Email</a>
      </nav>
    `

    // Step 1: Collect same-domain links
    const allLinks = collectSameDomainLinks(html, seedUrl)

    // Should include navigable same-domain pages, exclude external/mailto/pdf
    expect(allLinks).toContain('https://corp.example.co.jp/about')
    expect(allLinks).toContain('https://corp.example.co.jp/services')
    expect(allLinks).toContain('https://corp.example.co.jp/pricing')
    expect(allLinks).toContain('https://corp.example.co.jp/blog')
    expect(allLinks).toContain('https://corp.example.co.jp/careers')
    expect(allLinks).toContain('https://corp.example.co.jp/contact')
    expect(allLinks).toContain('https://corp.example.co.jp/login')
    expect(allLinks).toContain('https://corp.example.co.jp/signup')
    expect(allLinks).toContain('https://corp.example.co.jp/my-account')
    expect(allLinks).not.toContain('https://other-domain.com/page')

    // Step 2: Filter out auth URLs
    const nonAuthLinks = allLinks.filter(url => !isAuthUrl(url))
    expect(nonAuthLinks).not.toContain('https://corp.example.co.jp/login')
    expect(nonAuthLinks).not.toContain('https://corp.example.co.jp/signup')
    expect(nonAuthLinks).not.toContain('https://corp.example.co.jp/my-account')

    // Step 3: Select top N pages (max 5 total including seed)
    const pagesToVisit = selectPagesToVisit(seedUrl, nonAuthLinks, 5)
    expect(pagesToVisit.length).toBeLessThanOrEqual(4) // max 4 sub-pages
    expect(pagesToVisit.length).toBeGreaterThan(0)

    // Verify none of the selected pages are auth pages
    for (const url of pagesToVisit) {
      expect(isAuthUrl(url)).toBe(false)
    }
  })

  it('handles a site with few navigable pages', () => {
    const seedUrl = 'https://small-site.com/'
    const html = `
      <a href="https://small-site.com/">Home</a>
      <a href="/about">About</a>
      <a href="https://external.com">External</a>
    `

    const links = collectSameDomainLinks(html, seedUrl)
    const filtered = links.filter(url => !isAuthUrl(url))
    const pages = selectPagesToVisit(seedUrl, filtered, 5)

    expect(pages).toHaveLength(1)
    expect(pages[0]).toBe('https://small-site.com/about')
  })

  it('handles a site where all links are auth-required', () => {
    const seedUrl = 'https://app.example.com/'
    const html = `
      <a href="/login">Login</a>
      <a href="/signup">Sign Up</a>
      <a href="/auth/google">Google Auth</a>
      <a href="/my-account">Account</a>
    `

    const links = collectSameDomainLinks(html, seedUrl)
    const filtered = links.filter(url => !isAuthUrl(url))
    const pages = selectPagesToVisit(seedUrl, filtered, 5)

    expect(pages).toHaveLength(0)
  })
})

describe('edge cases', () => {
  it('handles URLs with international domain names', () => {
    const html = '<a href="https://example.com/page">Link</a>'
    const links = collectSameDomainLinks(html, 'https://example.com/')
    expect(links).toContain('https://example.com/page')
  })

  it('handles URLs with ports', () => {
    const html = `
      <a href="https://example.com:8080/about">About</a>
      <a href="https://example.com/about">About No Port</a>
    `
    // Links with port 8080 should NOT match example.com (no port)
    const links = collectSameDomainLinks(html, 'https://example.com/')
    expect(links).not.toContain('https://example.com:8080/about')
    expect(links).toContain('https://example.com/about')
  })

  it('handles deeply nested paths', () => {
    const html = '<a href="/a/b/c/d/e/f/page">Deep</a>'
    const links = collectSameDomainLinks(html, 'https://example.com/')
    expect(links).toContain('https://example.com/a/b/c/d/e/f/page')
  })

  it('handles URLs with encoded characters', () => {
    const html = '<a href="/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E">Search</a>'
    const links = collectSameDomainLinks(html, 'https://example.com/')
    expect(links).toHaveLength(1)
    expect(links[0]).toContain('example.com/search')
  })

  it('handles empty HTML', () => {
    const links = collectSameDomainLinks('', 'https://example.com/')
    expect(links).toEqual([])
  })

  it('handles HTML with no anchor tags', () => {
    const html = '<div><p>No links</p><img src="/image.png"></div>'
    const links = collectSameDomainLinks(html, 'https://example.com/')
    expect(links).toEqual([])
  })

  it('handles malformed href values gracefully', () => {
    const html = `
      <a href="">Empty</a>
      <a href="   ">Spaces</a>
      <a href="://broken">Broken Protocol</a>
      <a href="https://example.com/valid">Valid</a>
    `
    // Should not throw, should still extract valid links
    const links = collectSameDomainLinks(html, 'https://example.com/')
    expect(links).toContain('https://example.com/valid')
  })
})
