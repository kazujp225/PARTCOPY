/**
 * Fast Crawler - Lightweight fetch+cheerio based crawler for high-concurrency bulk processing.
 *
 * Replaces Puppeteer-based crawling for bulk operations.
 * Can handle 1000+ concurrent requests with minimal memory.
 *
 * Pipeline:
 * 1. Fetch HTML via HTTP
 * 2. Parse with cheerio
 * 3. Extract sections using heuristics (same logic as section-detector.ts)
 * 4. Classify sections (same logic as classifier.ts)
 * 5. Download CSS for styling context
 * 6. Store results to DB + storage
 */
import * as cheerio from 'cheerio'
import { randomUUID } from 'crypto'
import pLimit from 'p-limit'
import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { logger } from './logger.js'
import { classifySection, type RawSection } from './classifier.js'
import { reclassifySections } from './claude-classifier.js'
import { HAS_SUPABASE, supabaseAdmin } from './supabase.js'
import { STORAGE_BUCKETS } from './storage-config.js'
import {
  createCrawlRun,
  createSourcePage,
  createSourceSection,
  upsertSourceSite,
  writeStoredFile,
  updateCrawlRun,
  failCrawlRun,
} from './local-store.js'

// ============================================================
// Configuration
// ============================================================
const CONCURRENCY = Number(process.env.FAST_CRAWL_CONCURRENCY || 50)
const FETCH_TIMEOUT = 15_000 // 15s per page fetch
const CSS_FETCH_TIMEOUT = 10_000
const ASSET_FETCH_TIMEOUT = 10_000
const MAX_CSS_FILES = 15 // limit CSS downloads per page
const MAX_IMAGES_PER_SECTION = 10 // limit image downloads per section
const MAX_SUBPAGES = Number(process.env.FAST_CRAWL_MAX_SUBPAGES || 3) // sub-pages per site
const QUEUE_FILE = path.resolve(process.cwd(), '.partcopy/crawl-queue.txt')
const DONE_FILE = path.resolve(process.cwd(), '.partcopy/crawl-done.txt')
const CHECK_INTERVAL = 5_000
const BATCH_SIZE = 1000 // process 1000 at a time
const SPA_MIN_SECTIONS = 1 // if fewer sections detected, flag as potential SPA

let running = false
let stats = { processed: 0, success: 0, failed: 0, active: 0, startedAt: 0 }

// ============================================================
// Section Detection (cheerio-based, mirrors section-detector.ts)
// ============================================================
const SECTION_HINT_RE = /\b(hero|feature|service|section|block|band|panel|faq|accordion|cta|contact|form|pricing|plan|footer|header|nav|menu|news|blog|voice|testimonial|company|about|gallery|works|flow|step|mv|fv|kv)\b/i
const COOKIE_RE = /cookie|consent|gdpr|onetrust|truste|cc-banner|cc-window|privacy.?banner|cookie.?notice/i
const HARD_SECTION_TAGS = new Set(['nav', 'header', 'footer'])
const SECTIONISH_TAGS = new Set(['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'])
const MICRO_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'small', 'label', 'li', 'dt', 'dd'])

interface DetectedSection {
  tagName: string
  outerHTML: string
  textContent: string
  classNames: string
  id: string
  features: {
    headingCount: number
    linkCount: number
    buttonCount: number
    formCount: number
    imageCount: number
    cardCount: number
    childCount: number
    listItemCount: number
    textLength: number
    hasVideo: boolean
    hasCTA: boolean
    hasForm: boolean
    hasImages: boolean
  }
  positionRatio: number
}

function scoreElement($: cheerio.CheerioAPI, el: cheerio.Cheerio<cheerio.Element>): number {
  const tag = el.prop('tagName')?.toLowerCase() || ''
  const cls = (el.attr('class') || '').toLowerCase()
  const id = (el.attr('id') || '').toLowerCase()
  const text = el.text() || ''

  let score = 0

  if (HARD_SECTION_TAGS.has(tag)) score += 6
  else if (SECTIONISH_TAGS.has(tag)) score += 3
  if (MICRO_TAGS.has(tag)) score -= 4

  if (SECTION_HINT_RE.test(cls) || SECTION_HINT_RE.test(id)) score += 2

  const headingCount = el.find('h1, h2, h3, h4, h5, h6').length
  if (headingCount > 0) score += 2

  const formCount = el.find('form').length
  if (formCount > 0) score += 2

  const imageCount = el.find('img, picture, svg').length
  if (imageCount > 0) score += 1

  const buttonCount = el.find('button, input[type="submit"], a.btn, [class*="button"], [class*="btn"]').length
  if (buttonCount > 0) score += 1

  const listItemCount = el.find('li').length
  if (listItemCount >= 3) score += 1

  if (text.length >= 120) score += 1

  const children = el.children()
  if (children.length <= 1 && text.length < 180 && !SECTION_HINT_RE.test(cls)) score -= 2

  return score
}

function isCookieBanner($: cheerio.CheerioAPI, el: cheerio.Cheerio<cheerio.Element>): boolean {
  const cls = (el.attr('class') || '') + ' ' + (el.attr('id') || '')
  return COOKIE_RE.test(cls)
}

/**
 * Wrapper div か判定。子を持つだけの構造的コンテナなら unwrap する。
 * header/nav/footer/section/article 等のセマンティックタグは unwrap しない。
 */
function isWrapperDiv($: cheerio.CheerioAPI, el: cheerio.Cheerio<cheerio.Element>): boolean {
  const tag = el.prop('tagName')?.toLowerCase() || ''
  if (HARD_SECTION_TAGS.has(tag) || SECTIONISH_TAGS.has(tag)) return false
  if (tag !== 'div') return false

  const cls = (el.attr('class') || '').toLowerCase()
  const id = (el.attr('id') || '').toLowerCase()

  // セクションヒントがあるクラス/IDは unwrap しない
  if (SECTION_HINT_RE.test(cls) || SECTION_HINT_RE.test(id)) return false

  // wrapper/container/inner/page/site 等の汎用コンテナパターン
  if (/\b(wrapper|container|inner|page|site|app|root|layout|content|main|body)\b/i.test(cls) ||
      /\b(wrapper|container|inner|page|site|app|root|layout)\b/i.test(id)) {
    return true
  }

  // 子が2つ以上のセマンティック要素を含むなら wrapper
  const semanticChildren = el.children().filter((_, c) => {
    const ct = $(c).prop('tagName')?.toLowerCase() || ''
    const cc = ($(c).attr('class') || '').toLowerCase()
    return SECTIONISH_TAGS.has(ct) || HARD_SECTION_TAGS.has(ct) || SECTION_HINT_RE.test(cc)
  }).length
  if (semanticChildren >= 2) return true

  return false
}

/**
 * 再帰的に要素を展開して、セクション候補を収集する。
 * ラッパーdivは子要素に展開し、セクション要素はそのまま候補にする。
 */
function collectCandidates(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<cheerio.Element>,
  result: cheerio.Cheerio<cheerio.Element>[],
  depth: number = 0
): void {
  if (depth > 6) return // 無限再帰防止

  const tag = el.prop('tagName')?.toLowerCase() || ''
  if (!tag || el.is('script, style, link, meta, noscript, br, hr')) return

  // wrapper div → 子に展開
  if (isWrapperDiv($, el)) {
    el.children().each((_, child) => {
      collectCandidates($, $(child), result, depth + 1)
    })
    return
  }

  // main → 子に展開
  if (tag === 'main') {
    el.children().each((_, child) => {
      collectCandidates($, $(child), result, depth + 1)
    })
    return
  }

  // div でセクションヒントなし + 子に複数のセクション候補がある → 展開
  if (tag === 'div' && !SECTION_HINT_RE.test((el.attr('class') || '').toLowerCase())) {
    const children = el.children()
    const sectionishChildren = children.filter((_, c) => {
      const ct = $(c).prop('tagName')?.toLowerCase() || ''
      const cc = ($(c).attr('class') || '').toLowerCase()
      return SECTIONISH_TAGS.has(ct) || HARD_SECTION_TAGS.has(ct) || SECTION_HINT_RE.test(cc) || scoreElement($, $(c)) >= 3
    }).length

    if (sectionishChildren >= 2) {
      children.each((_, child) => {
        collectCandidates($, $(child), result, depth + 1)
      })
      return
    }
  }

  result.push(el)
}

function detectSectionsCheerio($: cheerio.CheerioAPI): DetectedSection[] {
  const sections: DetectedSection[] = []
  const seen = new Set<string>()

  // 再帰的に候補を収集
  const candidates: cheerio.Cheerio<cheerio.Element>[] = []

  // body の直接の子から再帰展開
  $('body').children().each((_, el) => {
    collectCandidates($, $(el), candidates, 0)
  })

  // セマンティック要素を追加（重複除去は後で行う）
  $('header, nav, section, article, aside, footer').each((_, el) => {
    const $el = $(el)
    // 既にcandidatesに含まれていなければ追加
    candidates.push($el)
  })

  const totalCandidates = candidates.length

  for (let i = 0; i < candidates.length; i++) {
    const $el = candidates[i]
    const tag = $el.prop('tagName')?.toLowerCase() || ''

    if (isCookieBanner($, $el)) continue

    const score = scoreElement($, $el)
    if (score < 2) continue

    const html = $.html($el) || ''
    // Deduplicate by content hash (first 300 chars to be more precise)
    const key = html.slice(0, 300)
    if (seen.has(key)) continue
    seen.add(key)

    const text = $el.text().replace(/\s+/g, ' ').trim()
    if (text.length < 10 && $el.find('img').length === 0) continue

    const cls = $el.attr('class') || ''
    const id = $el.attr('id') || ''

    const headingCount = $el.find('h1, h2, h3, h4, h5, h6').length
    const linkCount = $el.find('a').length
    const buttonCount = $el.find('button, input[type="submit"], a.btn, [class*="button"], [class*="btn"]').length
    const formCount = $el.find('form').length
    const imageCount = $el.find('img, picture, svg, [style*="background-image"]').length
    const cardCount = $el.find('[class*="card"], [class*="item"], [class*="col-"]').length
    const childCount = $el.children().length
    const listItemCount = $el.find('li').length
    const hasVideo = $el.find('video, iframe[src*="youtube"], iframe[src*="vimeo"]').length > 0
    const hasCTA = buttonCount > 0 || $el.find('a[href]').filter((_, a) => {
      const t = $(a).text().trim()
      return /お問い合わせ|資料|無料|申し込|contact|sign.?up|get.?started|try|demo/i.test(t)
    }).length > 0

    sections.push({
      tagName: tag,
      outerHTML: html.slice(0, 500_000), // limit to 500KB per section
      textContent: text.slice(0, 5000),
      classNames: cls,
      id,
      features: {
        headingCount, linkCount, buttonCount, formCount, imageCount,
        cardCount, childCount, listItemCount,
        textLength: text.length,
        hasVideo,
        hasCTA,
        hasForm: formCount > 0,
        hasImages: imageCount > 0,
      },
      positionRatio: totalCandidates > 1 ? i / (totalCandidates - 1) : 0.5,
    })
  }

  return sections
}

// ============================================================
// CSS Extraction
// ============================================================
async function fetchCss(url: string, baseUrl: string): Promise<string> {
  try {
    const resolved = new URL(url, baseUrl).href
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CSS_FETCH_TIMEOUT)
    const res = await fetch(resolved, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })
    clearTimeout(timer)
    if (!res.ok) return ''
    return await res.text()
  } catch {
    return ''
  }
}

async function extractAllCss($: cheerio.CheerioAPI, pageUrl: string): Promise<string> {
  const parts: string[] = []

  // Inline <style> tags
  $('style').each((_, el) => {
    const text = $(el).text()
    if (text.trim()) parts.push(text)
  })

  // Linked stylesheets
  const linkHrefs: string[] = []
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href')
    if (href) linkHrefs.push(href)
  })

  // Fetch external CSS (limited)
  const toFetch = linkHrefs.slice(0, MAX_CSS_FILES)
  const cssResults = await Promise.allSettled(
    toFetch.map(href => fetchCss(href, pageUrl))
  )
  for (const r of cssResults) {
    if (r.status === 'fulfilled' && r.value) parts.push(r.value)
  }

  return parts.join('\n')
}

// ============================================================
// Image Download
// ============================================================
async function downloadAsset(url: string, baseUrl: string): Promise<{ url: string; buffer: Buffer; contentType: string } | null> {
  try {
    const resolved = new URL(url, baseUrl).href
    if (resolved.startsWith('data:')) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ASSET_FETCH_TIMEOUT)
    const res = await fetch(resolved, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || 'application/octet-stream'
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > 5_000_000) return null // skip files > 5MB
    return { url: resolved, buffer: buf, contentType: ct }
  } catch {
    return null
  }
}

function extractImageUrls($: cheerio.CheerioAPI, el: cheerio.Cheerio<cheerio.Element>): string[] {
  const urls: string[] = []
  el.find('img').each((_, img) => {
    const src = $(img).attr('src')
    if (src && !src.startsWith('data:')) urls.push(src)
  })
  el.find('[style*="background-image"]').each((_, e) => {
    const style = $(e).attr('style') || ''
    const match = style.match(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/i)
    if (match && match[1] && !match[1].startsWith('data:')) urls.push(match[1])
  })
  el.find('picture source').each((_, s) => {
    const srcset = $(s).attr('srcset')
    if (srcset) {
      srcset.split(',').forEach(entry => {
        const url = entry.trim().split(/\s+/)[0]
        if (url && !url.startsWith('data:')) urls.push(url)
      })
    }
  })
  return [...new Set(urls)].slice(0, MAX_IMAGES_PER_SECTION)
}

// ============================================================
// Font Extraction from CSS
// ============================================================
function extractFontUrls(css: string, baseUrl: string): string[] {
  const urls: string[] = []
  const re = /@font-face\s*\{[^}]*url\(\s*['"]?([^'")\s]+)['"]?\s*\)[^}]*\}/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    if (m[1] && !m[1].startsWith('data:')) {
      try {
        urls.push(new URL(m[1], baseUrl).href)
      } catch {}
    }
  }
  return [...new Set(urls)].slice(0, 20)
}

// ============================================================
// Sub-page Link Extraction
// ============================================================
function extractSubpageLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const parsedBase = new URL(baseUrl)
  const domain = parsedBase.hostname
  const links: string[] = []
  const seen = new Set<string>()
  seen.add(parsedBase.pathname)

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    try {
      const resolved = new URL(href, baseUrl)
      if (resolved.hostname !== domain) return
      // Skip anchors, files, query-heavy URLs
      if (resolved.hash && resolved.pathname === parsedBase.pathname) return
      if (/\.(pdf|zip|png|jpg|gif|svg|mp4|mp3|doc|xls|ppt)/i.test(resolved.pathname)) return

      const clean = resolved.origin + resolved.pathname
      if (seen.has(resolved.pathname)) return
      seen.add(resolved.pathname)
      links.push(clean)
    } catch {}
  })

  // Prioritize important pages
  const priority = /\/(about|company|service|product|contact|recruit|career|news|blog|faq|pricing|feature)/i
  const sorted = links.sort((a, b) => {
    const aP = priority.test(a) ? 0 : 1
    const bP = priority.test(b) ? 0 : 1
    return aP - bP
  })

  return sorted.slice(0, MAX_SUBPAGES)
}

// ============================================================
// Single URL Processing
// ============================================================
async function fetchPage(url: string): Promise<{ html: string; finalUrl: string; $ : cheerio.CheerioAPI } | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
      },
      redirect: 'follow',
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return null

    // Handle encoding properly (Shift_JIS, EUC-JP, etc.)
    const buffer = Buffer.from(await res.arrayBuffer())
    let charset = 'utf-8'

    // Check Content-Type header for charset
    const ctMatch = ct.match(/charset=([^\s;]+)/i)
    if (ctMatch) charset = ctMatch[1].toLowerCase()

    // Check meta tag for charset
    const headStr = buffer.slice(0, 2048).toString('ascii')
    const metaMatch = headStr.match(/charset=["']?([^\s"';>]+)/i)
    if (metaMatch && !ctMatch) charset = metaMatch[1].toLowerCase()

    // Decode with proper charset
    let html: string
    const charsetNorm = charset.replace(/[-_]/g, '').toLowerCase()
    if (charsetNorm === 'utf8') {
      html = buffer.toString('utf-8')
    } else {
      try {
        const decoder = new TextDecoder(charset)
        html = decoder.decode(buffer)
      } catch {
        html = buffer.toString('utf-8') // fallback
      }
    }

    if (html.length < 100) return null
    return { html, finalUrl: res.url || url, $: cheerio.load(html, { decodeEntities: true }) }
  } catch {
    return null
  }
}

async function processUrl(url: string): Promise<{ success: boolean; sections: number; spaFlagged?: boolean; error?: string }> {
  const startTime = Date.now()

  try {
    // 1. Fetch HTML
    const page = await fetchPage(url)
    if (!page) return { success: false, sections: 0, error: 'Fetch failed or not HTML' }
    const { $, finalUrl } = page
    const title = $('title').text().trim() || ''

    // 2. Detect sections
    const detectedSections = detectSectionsCheerio($)

    // SPA detection: too few sections + heavy JS indicators
    const scriptCount = $('script[src]').length
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim()
    const isSpa = detectedSections.length <= SPA_MIN_SECTIONS && (
      scriptCount > 5 ||
      $('div#root, div#app, div#__next, div#__nuxt').length > 0 ||
      bodyText.length < 200
    )

    if (detectedSections.length === 0) {
      return { success: false, sections: 0, spaFlagged: isSpa, error: isSpa ? 'SPA detected (needs Puppeteer)' : 'No sections detected' }
    }

    // 3. Extract CSS
    const cssBundle = await extractAllCss($, finalUrl)

    // 4. Skip font download for speed (placeholder approach)

    // 5. Extract sub-page links
    const subpageLinks = extractSubpageLinks($, finalUrl)

    // 6. Create DB records
    const parsedUrl = new URL(finalUrl)
    const domain = parsedUrl.hostname.replace(/^www\./, '')

    // Upsert source site
    let siteId: string
    if (HAS_SUPABASE) {
      const { data: existingSite } = await supabaseAdmin
        .from('source_sites')
        .select('id')
        .eq('normalized_domain', domain)
        .maybeSingle()

      if (existingSite) {
        siteId = existingSite.id
        await supabaseAdmin
          .from('source_sites')
          .update({ last_crawled_at: new Date().toISOString(), status: 'analyzed' })
          .eq('id', siteId)
      } else {
        const { data: newSite, error } = await supabaseAdmin
          .from('source_sites')
          .insert({
            normalized_domain: domain,
            homepage_url: finalUrl,
            language: 'ja',
            genre: '',
            tags: ['fast-crawl'],
            status: 'analyzed',
          })
          .select('id')
          .single()
        if (error) throw new Error(error.message)
        siteId = newSite.id
      }
    } else {
      const site = await upsertSourceSite(domain, finalUrl, '', [])
      siteId = site.id
    }

    // Create crawl run
    let jobId: string
    if (HAS_SUPABASE) {
      const { data: job, error } = await supabaseAdmin
        .from('crawl_runs')
        .insert({
          site_id: siteId,
          status: 'done',
          trigger_type: 'manual',
          worker_id: 'fast-crawler',
          page_count: 1,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      jobId = job.id
    } else {
      const job = await createCrawlRun(siteId, finalUrl, 1)
      jobId = job.id
      await updateCrawlRun(jobId, { status: 'done', finished_at: new Date().toISOString() })
    }

    // Create source page
    let pageId: string
    const pagePath = parsedUrl.pathname || '/'
    const cssBundlePath = `${siteId}/${jobId}/css-bundle.css`
    if (HAS_SUPABASE) {
      // Store CSS bundle
      if (cssBundle) {
        await supabaseAdmin.storage
          .from(STORAGE_BUCKETS.RAW_HTML)
          .upload(cssBundlePath, Buffer.from(cssBundle), { contentType: 'text/css', upsert: true })
      }

      const { data: page, error } = await supabaseAdmin
        .from('source_pages')
        .insert({
          crawl_run_id: jobId,
          site_id: siteId,
          url: finalUrl,
          path: pagePath,
          title,
          page_type: 'home',
          css_bundle_path: cssBundle ? cssBundlePath : null,
        })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      pageId = page.id
    } else {
      if (cssBundle) {
        await writeStoredFile(STORAGE_BUCKETS.RAW_HTML, cssBundlePath, Buffer.from(cssBundle), 'text/css')
      }
      const page = await createSourcePage({
        crawl_run_id: jobId,
        site_id: siteId,
        url: finalUrl,
        path: pagePath,
        title,
        page_type: 'home',
        css_bundle_path: cssBundle ? cssBundlePath : null,
      })
      pageId = page.id
    }

    // 7. Store sections
    let storedCount = 0

    // Dedup: track seen text summaries across all pages for this site
    const seenTexts = new Set<string>()

    async function storeSectionsForPage(
      sections: DetectedSection[],
      pageIdForSections: string,
      pageUrl: string,
      orderOffset: number
    ) {
      for (let i = 0; i < sections.length; i++) {
        const sec = sections[i]

        // Dedup check: skip sections with duplicate text_summary (first 200 chars)
        const dedupKey = sec.textContent.slice(0, 200).trim()
        if (dedupKey.length > 0 && seenTexts.has(dedupKey)) {
          logger.debug('Fast-crawl: skipping duplicate section', { pageUrl, dedupKey: dedupKey.slice(0, 60) })
          continue
        }
        if (dedupKey.length > 0) {
          seenTexts.add(dedupKey)
        }

        // Classify
        const rawSection: RawSection = {
          tagName: sec.tagName,
          outerHTML: sec.outerHTML,
          textContent: sec.textContent,
          boundingBox: { x: 0, y: 0, width: 1440, height: 400 },
          computedStyles: {},
          hasImages: sec.features.hasImages,
          hasCTA: sec.features.hasCTA,
          hasForm: sec.features.hasForm,
          headingCount: sec.features.headingCount,
          linkCount: sec.features.linkCount,
          cardCount: sec.features.cardCount,
          childCount: sec.features.childCount,
          classNames: sec.classNames,
          id: sec.id,
        }
        const classification = classifySection(rawSection, sec.positionRatio)

        // Keep original image URLs (placeholder approach - skip download for speed)
        let sectionHtml = sec.outerHTML

        // Store section HTML
        const sectionId = randomUUID()
        const htmlPath = `${siteId}/${jobId}/sections/${sectionId}.html`

        if (HAS_SUPABASE) {
          await supabaseAdmin.storage
            .from(STORAGE_BUCKETS.RAW_HTML)
            .upload(htmlPath, Buffer.from(sectionHtml), { contentType: 'text/html', upsert: true })

          await supabaseAdmin
            .from('source_sections')
            .insert({
              id: sectionId,
              page_id: pageIdForSections,
              site_id: siteId,
              order_index: orderOffset + i,
              tag_name: sec.tagName,
              block_family: classification.type,
              classifier_confidence: classification.confidence,
              raw_html_storage_path: htmlPath,
              text_summary: sec.textContent.slice(0, 300),
              features_jsonb: sec.features,
              bbox_json: { x: 0, y: 0, width: 1440, height: 400 },
            })
        } else {
          await writeStoredFile(STORAGE_BUCKETS.RAW_HTML, htmlPath, Buffer.from(sectionHtml), 'text/html')
          await createSourceSection({
            id: sectionId,
            page_id: pageIdForSections,
            site_id: siteId,
            order_index: orderOffset + i,
            tag_name: sec.tagName,
            block_family: classification.type,
            classifier_confidence: classification.confidence,
            raw_html_storage_path: htmlPath,
            text_summary: sec.textContent.slice(0, 300),
            features_jsonb: sec.features,
            bbox_json: { x: 0, y: 0, width: 1440, height: 400 },
          })
        }
        storedCount++
      }
    }

    // Store home page sections
    await storeSectionsForPage(detectedSections, pageId, finalUrl, 0)

    // 9. Crawl sub-pages
    for (const subUrl of subpageLinks) {
      try {
        const subPage = await fetchPage(subUrl)
        if (!subPage) continue

        const subSections = detectSectionsCheerio(subPage.$)
        if (subSections.length === 0) continue

        const subPath = new URL(subPage.finalUrl).pathname || '/'

        // Create sub-page record
        let subPageId: string
        if (HAS_SUPABASE) {
          const { data: sp, error } = await supabaseAdmin
            .from('source_pages')
            .insert({
              crawl_run_id: jobId,
              site_id: siteId,
              url: subPage.finalUrl,
              path: subPath,
              title: subPage.$('title').text().trim() || '',
              page_type: 'sub',
              css_bundle_path: cssBundlePath,
            })
            .select('id')
            .single()
          if (error) continue
          subPageId = sp.id
        } else {
          const sp = await createSourcePage({
            crawl_run_id: jobId,
            site_id: siteId,
            url: subPage.finalUrl,
            path: subPath,
            title: subPage.$('title').text().trim() || '',
            page_type: 'sub',
            css_bundle_path: cssBundlePath,
          })
          subPageId = sp.id
        }

        await storeSectionsForPage(subSections, subPageId, subPage.finalUrl, storedCount)
      } catch (err: any) {
        logger.debug('Fast-crawl: sub-page failed', { url: subUrl, error: err.message })
      }
    }

    // Update page_count
    if (HAS_SUPABASE) {
      try {
        await supabaseAdmin
          .from('crawl_runs')
          .update({ page_count: 1 + subpageLinks.length, section_count: storedCount })
          .eq('id', jobId)
      } catch {}
    }

    // 10. Queue Claude reclassification for this site (background, non-blocking)
    if (HAS_SUPABASE && storedCount > 0) {
      reclassifySections({ siteId, limit: storedCount + 10 })
        .then(r => {
          if (r.updated > 0) logger.info('Fast-crawl: claude reclassified', { url: domain, updated: r.updated })
        })
        .catch(() => {}) // non-blocking
    }

    const elapsed = Date.now() - startTime
    logger.info('Fast-crawl: processed', { url: domain, sections: storedCount, subPages: subpageLinks.length, spa: isSpa, ms: elapsed })
    return { success: true, sections: storedCount, spaFlagged: isSpa }
  } catch (err: any) {
    const elapsed = Date.now() - startTime
    logger.warn('Fast-crawl: failed', { url, error: err.message, ms: elapsed })
    return { success: false, sections: 0, error: err.message }
  }
}

// ============================================================
// Queue Management
// ============================================================
async function readQueue(): Promise<string[]> {
  if (!existsSync(QUEUE_FILE)) return []
  try {
    const content = await readFile(QUEUE_FILE, 'utf-8')
    return content.split('\n').map(l => l.trim()).filter(l => l.length > 0 && /^https?:\/\//i.test(l))
  } catch { return [] }
}

async function readDone(): Promise<Set<string>> {
  if (!existsSync(DONE_FILE)) return new Set()
  try {
    const content = await readFile(DONE_FILE, 'utf-8')
    return new Set(content.split('\n').map(l => l.split('\t')[0].trim()).filter(l => l.length > 0))
  } catch { return new Set() }
}

async function markDone(urls: string[]): Promise<void> {
  const dir = path.dirname(DONE_FILE)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const entries = urls.map(u => `${u}\t${new Date().toISOString()}`).join('\n') + '\n'
  await appendFile(DONE_FILE, entries, 'utf-8')
}

async function dequeueUrls(urls: string[]): Promise<void> {
  const removeSet = new Set(urls)
  const lines = await readQueue()
  const remaining = lines.filter(l => !removeSet.has(l))
  await writeFile(QUEUE_FILE, remaining.length > 0 ? remaining.join('\n') + '\n' : '', 'utf-8')
}

// ============================================================
// Batch Processor
// ============================================================
async function processBatch(urls: string[]): Promise<void> {
  const limit = pLimit(CONCURRENCY)
  stats.active = urls.length

  const results = await Promise.allSettled(
    urls.map(url => limit(async () => {
      const result = await processUrl(url)
      stats.processed++
      if (result.success) stats.success++
      else stats.failed++
      stats.active--

      // Log progress every 100
      if (stats.processed % 100 === 0) {
        const elapsed = (Date.now() - stats.startedAt) / 1000
        const rate = stats.processed / elapsed * 3600
        logger.info('Fast-crawl: progress', {
          processed: stats.processed,
          success: stats.success,
          failed: stats.failed,
          active: stats.active,
          ratePerHour: Math.round(rate),
        })
      }

      return result
    }))
  )

  // Mark all as done and dequeue
  await markDone(urls)
  await dequeueUrls(urls)
}

// ============================================================
// Main Loop
// ============================================================
let stopped = false

async function runFastCrawlLoop(): Promise<void> {
  if (running) return
  running = true

  while (!stopped) {
    const queue = await readQueue()
    const done = await readDone()
    const pending = queue.filter(u => !done.has(u))

    if (pending.length === 0) {
      running = false
      return
    }

    const batch = pending.slice(0, BATCH_SIZE)
    logger.info('Fast-crawl: starting batch', { batchSize: batch.length, totalRemaining: pending.length })

    stats = { processed: 0, success: 0, failed: 0, active: 0, startedAt: Date.now() }
    await processBatch(batch)

    const elapsed = (Date.now() - stats.startedAt) / 1000
    logger.info('Fast-crawl: batch complete', {
      processed: stats.processed,
      success: stats.success,
      failed: stats.failed,
      elapsedSeconds: Math.round(elapsed),
      ratePerHour: Math.round(stats.processed / elapsed * 3600),
    })
  }

  running = false
}

// ============================================================
// Exports
// ============================================================
export function startFastCrawler(): void {
  stopped = false
  logger.info('Fast-crawl: starting', { concurrency: CONCURRENCY, batchSize: BATCH_SIZE })

  // Check queue periodically
  const check = async () => {
    if (stopped) return
    const queue = await readQueue()
    if (queue.length > 0 && !running) {
      runFastCrawlLoop().catch(err => {
        logger.error('Fast-crawl: loop error', { error: err.message })
        running = false
      })
    }
  }

  check()
  const interval = setInterval(check, CHECK_INTERVAL)
  interval.unref()
}

export function stopFastCrawler(): void {
  stopped = true
  logger.info('Fast-crawl: stopped')
}

export function getFastCrawlStats() {
  return { ...stats, running, concurrency: CONCURRENCY }
}

/**
 * Direct batch processing without queue file.
 * Used by API endpoint for immediate bulk crawling.
 */
export async function fastCrawlUrls(urls: string[]): Promise<{
  total: number
  success: number
  failed: number
  elapsedMs: number
  ratePerHour: number
}> {
  const start = Date.now()
  const limit = pLimit(CONCURRENCY)
  let success = 0
  let failed = 0

  await Promise.allSettled(
    urls.map(url => limit(async () => {
      const result = await processUrl(url)
      if (result.success) success++
      else failed++
    }))
  )

  const elapsed = Date.now() - start
  return {
    total: urls.length,
    success,
    failed,
    elapsedMs: elapsed,
    ratePerHour: Math.round(urls.length / (elapsed / 1000) * 3600),
  }
}
