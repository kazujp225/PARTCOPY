/**
 * API Server - Lightweight. No Puppeteer.
 * Creates jobs, serves results from Supabase.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import archiver from 'archiver'
import {
  addPatches,
  createCrawlRun,
  createPatchSet,
  createProjectPageBlock,
  deleteSection as deleteLocalSection,
  getBlockInstance,
  getDefaultBlockVariant,
  getFamilySummary,
  getGenreSummary,
  getJob,
  getLatestResolvedSnapshot,
  getPageByCrawlRun,
  getPagesByCrawlRun,
  getPageById,
  getPatchSet,
  getPatches,
  getSection,
  getSectionNodes,
  getSectionsByPage,
  getStoredFileResponse,
  listBlockVariants,
  listLibrarySections,
  readStoredText,
  upsertSourceSite,
  listProjects,
  createProject as createLocalProject,
  updateProject as updateLocalProject,
  deleteProject as deleteLocalProject
} from './local-store.js'
import { HAS_SUPABASE, supabaseAdmin } from './supabase.js'
import { STORAGE_BUCKETS } from './storage-config.js'
import { logger } from './logger.js'
import { convertHtmlToTsx } from './claude-converter.js'
import {
  collectCssAssetUrls,
  collectHtmlAssetUrls,
  createSectionScopeClass,
  parseStoredAssetUrl,
  rewriteCssAssetUrls,
  rewriteCssUrls,
  rewriteHtmlAssetUrls,
  scopeCss,
  scopeHtmlInlineVars,
  stripVideoElements,
  extractHtmlTokens,
  filterCssForSection
} from './render-utils.js'
import { extractColorsFromCss, extractFontsFromCss, generateDesignTokensCss, generateBrandGuide } from './design-tokens.js'

/**
 * Sanitize error messages before sending to clients.
 * Prevents leaking internal paths, stack traces, or DB details.
 */
function safeErrorMessage(err: any): string {
  const msg = err?.message || 'Internal server error'
  // Block messages that look like they contain file paths or stack traces
  if (/\/[a-z_\-]+\//i.test(msg) || msg.includes('ENOENT') || msg.includes('at ') || msg.includes('node_modules')) {
    return 'Internal server error'
  }
  return msg
}

/**
 * Simple in-memory rate limiter for expensive endpoints.
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
function rateLimit(key: string, maxPerWindow: number, windowMs: number): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (entry.count >= maxPerWindow) return false
  entry.count++
  return true
}

const app = express()
app.use(cors({
  origin: (origin, callback) => {
    const allowed = (process.env.CORS_ORIGIN || 'http://localhost:5180,http://127.0.0.1:5180').split(',')
    // Allow requests with no origin (curl, server-to-server)
    if (!origin || allowed.includes(origin)) {
      callback(null, true)
    } else {
      callback(null, false)
    }
  },
  credentials: true
}))
app.use(express.json({ limit: '1mb' }))

// ============================================================
// Health check
// ============================================================
app.get('/api/health', async (_req, res) => {
  const checks: Record<string, string> = { server: 'ok' }

  // Check DB
  try {
    if (HAS_SUPABASE) {
      const { error } = await supabaseAdmin.from('crawl_runs').select('id').limit(1)
      checks.db = error ? 'fail' : 'ok'
    } else {
      // Local mode - check if db file is readable
      const fs = await import('fs/promises')
      await fs.access('.partcopy/db.json')
      checks.db = 'ok'
    }
  } catch {
    checks.db = 'fail'
  }

  const allOk = Object.values(checks).every(v => v === 'ok')
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'healthy' : 'degraded', checks })
})

const buildRenderDocument = (
  storedHtml: string,
  pageOrigin: string,
  options?: { cssBundle?: string; extraHead?: string; extraBodyEnd?: string; skipBase?: boolean }
) => {
  const headParts = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    options?.skipBase ? '' : `<base href="${pageOrigin}/">`,
    options?.cssBundle ? `<style>${options.cssBundle}</style>` : '',
    options?.extraHead || ''
  ].filter(Boolean)

  const injection = headParts.join('')

  if (/<html[\s>]/i.test(storedHtml)) {
    let html = storedHtml

    if (!/<head[\s>]/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, '<html$1><head></head>')
    }

    if (!/<body[\s>]/i.test(html)) {
      html = html.replace(/<\/head>/i, '</head><body></body>')
    }

    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${injection}</head>`)
    } else {
      html = html.replace(/<head([^>]*)>/i, `<head$1>${injection}`)
    }

    if (options?.extraBodyEnd) {
      if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${options.extraBodyEnd}</body>`)
      } else {
        html += options.extraBodyEnd
      }
    }

    return html
  }

  return `<!DOCTYPE html>
<html lang="ja">
<head>${injection}</head>
<body>${storedHtml}${options?.extraBodyEnd || ''}</body>
</html>`
}

/**
 * HTML内の相対URLをpageOriginで絶対URLに書き換える。
 * <base>を使うとCSS linkの/assets/パスも壊れるため、直接書き換えで対処。
 */
function resolveRelativeUrls(html: string, pageOrigin: string): string {
  if (!pageOrigin) return html

  // src, href, srcset, poster, action 属性の相対URLを書き換え
  let result = html.replace(
    /(src|href|srcset|poster|action)=(["'])(?!data:|https?:\/\/|\/\/|#|mailto:|tel:|javascript:|\/?assets\/)((?:(?!\2).)*)\2/gi,
    (match, attr, q, rawPath) => {
      if (attr.toLowerCase() === 'srcset') {
        const rewritten = rawPath.split(',').map((segment: string) => {
          const parts = segment.trim().split(/\s+/)
          try {
            parts[0] = new URL(parts[0], pageOrigin + '/').href
          } catch {}
          return parts.join(' ')
        }).join(', ')
        return `${attr}=${q}${rewritten}${q}`
      }
      try {
        const resolved = new URL(rawPath, pageOrigin + '/').href
        return `${attr}=${q}${resolved}${q}`
      } catch {}
      return match
    }
  )

  // inline style の background-image url() も解決
  result = result.replace(
    /url\(\s*(['"]?)(?!data:|https?:\/\/|\/\/|\/?assets\/)((?:(?!\1\)).)*)\1\s*\)/gi,
    (match, q, rawPath) => {
      try {
        const resolved = new URL(rawPath, pageOrigin + '/').href
        return `url(${q}${resolved}${q})`
      } catch {}
      return match
    }
  )

  return result
}

const PARTCOPY_BASE_CSS = `
html, body {
  margin: 0;
  padding: 0;
}

body {
  background: #ffffff;
}

.pc-preview-page {
  width: 100%;
  overflow-x: hidden;
}

[data-partcopy-section] {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  float: none;
  clear: both;
  position: relative;
  overflow: hidden;
}

[data-partcopy-section] > *:first-child {
  margin-top: 0 !important;
}

[data-partcopy-section] > *:last-child {
  margin-bottom: 0 !important;
}

.pc-preview-page > [data-partcopy-section] + [data-partcopy-section] {
  border-top: none;
  margin-top: 0;
}
`.trim()

interface PreparedSectionRender {
  sectionId: string
  blockFamily: string
  scopeClass: string
  html: string
  css: string
  fontFaceCss: string[]
}

interface ExportAssetFile {
  exportPath: string
  buffer: Buffer
}

function getPageOrigin(pageUrl?: string | null) {
  if (!pageUrl) return ''
  try {
    return new URL(pageUrl).origin
  } catch {
    return ''
  }
}

function guessContentTypeFromPath(filePath: string) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8'
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8'
  if (lower.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.woff')) return 'font/woff'
  if (lower.endsWith('.woff2')) return 'font/woff2'
  if (lower.endsWith('.ttf')) return 'font/ttf'
  if (lower.endsWith('.otf')) return 'font/otf'
  if (lower.endsWith('.eot')) return 'application/vnd.ms-fontobject'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.webm')) return 'video/webm'
  return 'application/octet-stream'
}

async function readBucketFile(bucket: string, storagePath?: string | null) {
  if (!storagePath) return null

  if (!HAS_SUPABASE) {
    try {
      return await getStoredFileResponse(bucket, storagePath)
    } catch {
      return null
    }
  }

  const { data, error } = await supabaseAdmin.storage.from(bucket).download(storagePath)
  if (!data || error) return null

  return {
    buffer: Buffer.from(await data.arrayBuffer()),
    contentType: data.type || guessContentTypeFromPath(storagePath)
  }
}

async function loadSectionCssBundle(cssBundlePath?: string | null) {
  if (!cssBundlePath) return ''

  let cssContent = await readBucketText(STORAGE_BUCKETS.SANITIZED_HTML, cssBundlePath)
  if (!cssContent) {
    cssContent = await readBucketText(STORAGE_BUCKETS.RAW_HTML, cssBundlePath)
  }

  return rewriteCssAssetUrls(cssContent, cssBundlePath)
}

function renderPreparedSection(prepared: PreparedSectionRender) {
  return `<section class="${prepared.scopeClass}" data-partcopy-section="${prepared.sectionId}">${prepared.html}</section>`
}

function buildStyleTags(cssBlocks: string[]) {
  return cssBlocks
    .filter((block) => block.trim().length > 0)
    .map((block) => `<style>${block}</style>`)
    .join('')
}

function dedupeStrings(values: string[]) {
  return [...new Set(values)]
}

function dedupeCssBlocks(blocks: string[]) {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const block of blocks) {
    const normalized = block.replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(block)
  }

  return unique
}

async function prepareSectionRender(sectionId: string): Promise<PreparedSectionRender | null> {
  const record = await getRenderContext(sectionId)
  if (!record?.section) return null
  if (!record.section.raw_html_storage_path && !record.section.sanitized_html_storage_path) return null

  let html = await readBucketText(STORAGE_BUCKETS.RAW_HTML, record.section.raw_html_storage_path)
  if (!html) {
    html = await readBucketText(STORAGE_BUCKETS.SANITIZED_HTML, record.section.sanitized_html_storage_path)
  }
  if (!html) return null

  const pageOrigin = getPageOrigin(record.page?.url)
  const scopeClass = createSectionScopeClass(sectionId)
  const cssBundle = await loadSectionCssBundle(record.page?.css_bundle_path)

  // Use full CSS bundle with scoping (filtering removed - too aggressive for complex sites)
  const { scopedCss, fontFaceCss } = scopeCss(cssBundle, scopeClass)

  return {
    sectionId,
    blockFamily: record.section.block_family || 'section',
    scopeClass,
    html: stripVideoElements(scopeHtmlInlineVars(resolveRelativeUrls(html, pageOrigin), scopeClass)),
    css: scopedCss,
    fontFaceCss
  }
}

function parseSectionIdsQuery(value: unknown) {
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((sectionId) => sectionId.trim())
    .filter(Boolean)
}

function getPathnameFromUrl(sourceUrl: string) {
  try {
    return new URL(sourceUrl).pathname
  } catch {
    return sourceUrl
  }
}

function extensionFromContentType(contentType: string) {
  const baseType = contentType.split(';')[0].trim().toLowerCase()
  const map: Record<string, string> = {
    'application/javascript': '.js',
    'application/json': '.json',
    'application/vnd.ms-fontobject': '.eot',
    'font/otf': '.otf',
    'font/ttf': '.ttf',
    'font/woff': '.woff',
    'font/woff2': '.woff2',
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
    'text/css': '.css',
    'text/html': '.html',
    'video/mp4': '.mp4',
    'video/webm': '.webm'
  }

  return map[baseType] || ''
}

function sanitizeExportStem(value: string) {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function buildExportAssetFileName(key: string, sourceUrl: string, contentType: string, fileNameHint?: string | null) {
  const candidateName = fileNameHint || path.posix.basename(getPathnameFromUrl(sourceUrl)) || 'asset'
  const ext = path.posix.extname(candidateName) || extensionFromContentType(contentType)
  const stem = sanitizeExportStem(candidateName) || 'asset'
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 10)
  return `${stem}-${hash}${ext}`
}

/**
 * Convert raw HTML string to JSX-compatible string.
 * Handles attribute renaming, self-closing tags, style parsing, etc.
 */
function htmlToJsx(html: string): string {
  let jsx = html

  // Remove HTML comments
  jsx = jsx.replace(/<!--[\s\S]*?-->/g, '')

  // Self-closing void elements
  const voidElements = 'area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr'
  jsx = jsx.replace(new RegExp(`<(${voidElements})(\\b[^>]*)(?<!/)>`, 'gi'), '<$1$2 />')

  // class → className
  jsx = jsx.replace(/\bclass=/g, 'className=')

  // for → htmlFor
  jsx = jsx.replace(/\bfor=/g, 'htmlFor=')

  // tabindex → tabIndex
  jsx = jsx.replace(/\btabindex=/g, 'tabIndex=')

  // readonly → readOnly
  jsx = jsx.replace(/\breadonly(?=[\s/>])/g, 'readOnly')

  // maxlength → maxLength
  jsx = jsx.replace(/\bmaxlength=/g, 'maxLength=')

  // colspan → colSpan, rowspan → rowSpan
  jsx = jsx.replace(/\bcolspan=/g, 'colSpan=')
  jsx = jsx.replace(/\browspan=/g, 'rowSpan=')

  // cellpadding → cellPadding, cellspacing → cellSpacing
  jsx = jsx.replace(/\bcellpadding=/g, 'cellPadding=')
  jsx = jsx.replace(/\bcellspacing=/g, 'cellSpacing=')

  // crossorigin → crossOrigin
  jsx = jsx.replace(/\bcrossorigin=/g, 'crossOrigin=')

  // autocomplete → autoComplete
  jsx = jsx.replace(/\bautocomplete=/g, 'autoComplete=')

  // Convert inline style strings to JSX objects
  jsx = jsx.replace(/\bstyle="([^"]*)"/g, (_match, styleStr: string) => {
    const pairs = styleStr
      .split(';')
      .map(s => s.trim())
      .filter(Boolean)
      .map(decl => {
        const colonIdx = decl.indexOf(':')
        if (colonIdx === -1) return null
        const prop = decl.slice(0, colonIdx).trim()
        const val = decl.slice(colonIdx + 1).trim()
        // Convert kebab-case to camelCase
        const camelProp = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        // Wrap value in quotes, handle numeric values
        const numericVal = parseFloat(val)
        if (!isNaN(numericVal) && String(numericVal) === val && !val.includes(' ')) {
          return `${camelProp}: ${numericVal}`
        }
        return `${camelProp}: "${val.replace(/"/g, '\\"')}"`
      })
      .filter(Boolean)
    return `style={{${pairs.join(', ')}}}`
  })

  // Remove boolean attributes without values (checked, disabled, etc.)
  // and convert to JSX: checked → checked={true} (already valid in JSX as standalone)

  // Remove on* event handlers (onclick, onload, etc.)
  jsx = jsx.replace(/\bon[a-z]+=["'][^"']*["']/gi, '')

  return jsx
}

function escapeTemplateLiteral(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
}

function toPascalCase(value: string) {
  return value
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('') || 'Section'
}

function extractTextsForGuide(html: string): string[] {
  const texts: string[] = []
  // Extract heading texts
  const headingRe = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi
  let match
  while ((match = headingRe.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '').trim()
    if (text && text.length > 0 && text.length < 200) texts.push(text)
  }
  // Extract button/link texts
  const btnRe = /<(?:button|a)\b[^>]*>([\s\S]*?)<\/(?:button|a)>/gi
  while ((match = btnRe.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '').trim()
    if (text && text.length > 0 && text.length < 100) texts.push(text)
  }
  // Extract paragraph texts (first 50 chars)
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi
  while ((match = pRe.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '').trim()
    if (text && text.length > 10) texts.push(text.slice(0, 80) + (text.length > 80 ? '...' : ''))
  }
  return [...new Set(texts)].slice(0, 15)
}

function extractImagesForGuide(html: string): string[] {
  const images: string[] = []
  const imgRe = /src=["']([^"']+)["']/gi
  let match
  while ((match = imgRe.exec(html)) !== null) {
    const src = match[1]
    if (/\.(png|jpe?g|gif|webp|avif|svg)/i.test(src)) {
      images.push(src)
    }
  }
  return [...new Set(images)].slice(0, 15)
}

async function loadExportAssetSource(sourceUrl: string) {
  const storedRef = parseStoredAssetUrl(sourceUrl)
  if (storedRef) {
    const buckets = dedupeStrings([storedRef.bucket, STORAGE_BUCKETS.RAW_HTML, STORAGE_BUCKETS.SANITIZED_HTML])
    for (const bucket of buckets) {
      const file = await readBucketFile(bucket, storedRef.storagePath)
      if (file) {
        return {
          key: `${bucket}:${storedRef.storagePath}`,
          fileNameHint: path.posix.basename(storedRef.storagePath),
          buffer: file.buffer,
          contentType: file.contentType
        }
      }
    }
  }

  if (!/^https?:\/\//i.test(sourceUrl)) return null

  try {
    const response = await fetch(sourceUrl)
    if (!response.ok) return null
    return {
      key: `url:${sourceUrl}`,
      fileNameHint: path.posix.basename(getPathnameFromUrl(sourceUrl)),
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || guessContentTypeFromPath(sourceUrl)
    }
  } catch {
    return null
  }
}

async function readBucketText(bucket: string, storagePath?: string | null) {
  if (!storagePath) return ''

  if (!HAS_SUPABASE) {
    try {
      return await readStoredText(bucket, storagePath)
    } catch {
      return ''
    }
  }

  const { data: file } = await supabaseAdmin.storage.from(bucket).download(storagePath)
  if (!file) return ''
  return file.text()
}

async function createExtractJobRecord(url: string, genre: string, tags: string[], maxPages: number = 5) {
  const parsedUrl = new URL(url)
  const domain = parsedUrl.hostname.replace(/^www\./, '')

  if (!HAS_SUPABASE) {
    const site = await upsertSourceSite({
      normalized_domain: domain,
      homepage_url: url,
      genre,
      tags,
      status: 'queued'
    })
    const job = await createCrawlRun({
      site_id: site.id,
      trigger_type: 'manual',
      status: 'queued',
      max_pages: maxPages
    })
    return { site, job }
  }

  const { data: site, error: siteErr } = await supabaseAdmin
    .from('source_sites')
    .upsert({
      normalized_domain: domain,
      homepage_url: url,
      genre,
      tags,
      status: 'queued'
    }, { onConflict: 'normalized_domain' })
    .select()
    .single()

  if (siteErr || !site) {
    throw new Error(siteErr?.message || 'Failed to create site')
  }

  const { data: job, error: jobErr } = await supabaseAdmin
    .from('crawl_runs')
    .insert({
      site_id: site.id,
      trigger_type: 'manual',
      status: 'queued',
      max_pages: maxPages
    })
    .select()
    .single()

  if (jobErr || !job) {
    throw new Error(jobErr?.message || 'Failed to create job')
  }

  return { site, job }
}

async function getJobRecord(jobId: string) {
  if (!HAS_SUPABASE) {
    return getJob(jobId)
  }

  const { data } = await supabaseAdmin
    .from('crawl_runs')
    .select('*, source_sites(normalized_domain, genre, tags)')
    .eq('id', jobId)
    .single()

  return data || null
}

async function getJobSectionsRecord(jobId: string) {
  if (!HAS_SUPABASE) {
    const pages = await getPagesByCrawlRun(jobId)
    if (!pages.length) return null
    // 全ページのセクションを結合（ページ順 → セクション順）
    const allSections: any[] = []
    for (const pg of pages) {
      const pageSections = await getSectionsByPage(pg.id)
      allSections.push(...pageSections)
    }
    // 最初のページをプライマリページとして返す（後方互換性）
    return { page: pages[0], sections: allSections }
  }

  const { data: pages, error: pageError } = await supabaseAdmin
    .from('source_pages')
    .select('id, css_bundle_path, url')
    .eq('crawl_run_id', jobId)
    .order('created_at')

  if (pageError) throw new Error(pageError.message)
  if (!pages || pages.length === 0) return null

  // 全ページからセクションを取得
  const pageIds = pages.map((p: any) => p.id)
  const { data: sections, error } = await supabaseAdmin
    .from('source_sections')
    .select('*, source_pages(url, title)')
    .in('page_id', pageIds)
    .order('order_index')

  if (error) throw new Error(error.message)
  return { page: pages[0], sections: sections || [] }
}

async function getRenderContext(sectionId: string) {
  if (!HAS_SUPABASE) {
    const resolvedSnapshot = await getLatestResolvedSnapshot(sectionId)
    const section = await getSection(sectionId)
    if (!section) return null
    const page = await getPageById(section.page_id)
    if (!page) return null
    return { resolvedSnapshot, section, page }
  }

  const { data: resolvedSnapshot } = await supabaseAdmin
    .from('section_dom_snapshots')
    .select('html_storage_path, css_strategy')
    .eq('section_id', sectionId)
    .eq('snapshot_type', 'resolved')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  const { data: section } = await supabaseAdmin
    .from('source_sections')
    .select('id, page_id, raw_html_storage_path, sanitized_html_storage_path, block_family')
    .eq('id', sectionId)
    .single()

  if (!section) return null

  const { data: page } = await supabaseAdmin
    .from('source_pages')
    .select('id, css_bundle_path, url')
    .eq('id', section.page_id)
    .single()

  if (!page) return null

  return { resolvedSnapshot, section, page }
}


async function getLibraryResults(filters: {
  genre?: string
  family?: string
  industry?: string
  limit: number
  q?: string
  sort?: string
  hasCta: boolean
  hasForm: boolean
  hasImages: boolean
}) {
  if (!HAS_SUPABASE) {
    return listLibrarySections(filters)
  }

  let query = supabaseAdmin
    .from('source_sections')
    .select('*, source_sites!inner(normalized_domain, genre, tags, industry), source_pages(url, title)')
    .order('created_at', { ascending: false })
    .limit(Math.max(filters.limit * 3, 500))

  if (filters.genre) query = query.eq('source_sites.genre', filters.genre)
  if (filters.family) query = query.eq('block_family', filters.family)
  if (filters.industry) query = query.eq('source_sites.industry', filters.industry)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const searchTerm = normalizeSearchValue(filters.q)
  let results = (data || []).filter((section: any) => {
    const featureFlags = section.features_jsonb || {}

    if (filters.hasCta && !featureFlags.hasCTA) return false
    if (filters.hasForm && !featureFlags.hasForm) return false
    if (filters.hasImages && !featureFlags.hasImages) return false
    if (!searchTerm) return true

    const searchable = [
      section.block_family,
      section.block_variant,
      section.text_summary,
      section.source_sites?.normalized_domain,
      section.source_sites?.genre,
      ...(section.source_sites?.tags || []),
      section.source_pages?.title,
      section.source_pages?.url
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    return searchable.includes(searchTerm)
  })

  results.sort((a: any, b: any) => {
    switch (filters.sort) {
      case 'confidence':
        return (b.classifier_confidence || 0) - (a.classifier_confidence || 0)
      case 'family':
        return String(a.block_family || '').localeCompare(String(b.block_family || ''))
      case 'source':
        return String(a.source_sites?.normalized_domain || '').localeCompare(String(b.source_sites?.normalized_domain || ''))
      case 'oldest':
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      case 'newest':
      default:
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    }
  })

  return results.slice(0, filters.limit)
}

async function getGenreResults() {
  if (!HAS_SUPABASE) {
    return getGenreSummary()
  }

  const { data, error } = await supabaseAdmin
    .from('source_sections')
    .select('source_sites!inner(genre)')

  if (error) throw new Error(error.message)

  const counts: Record<string, number> = {}
  for (const row of data || []) {
    const sites = Array.isArray(row.source_sites) ? row.source_sites : [row.source_sites]
    for (const site of sites) {
      const genre = site?.genre || 'untagged'
      counts[genre] = (counts[genre] || 0) + 1
    }
  }

  return Object.entries(counts)
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count)
}

async function getFamilyResults() {
  if (!HAS_SUPABASE) {
    return getFamilySummary()
  }

  const [{ data: families, error }, { data: sections, error: countsError }] = await Promise.all([
    supabaseAdmin
      .from('block_families')
      .select('key, label, label_ja, sort_order')
      .order('sort_order'),
    supabaseAdmin
      .from('source_sections')
      .select('block_family')
  ])

  if (error || countsError) {
    throw new Error(error?.message || countsError?.message || 'Failed to load families')
  }

  const counts = (sections || []).reduce((acc: Record<string, number>, row: any) => {
    const familyKey = row.block_family || 'content'
    acc[familyKey] = (acc[familyKey] || 0) + 1
    return acc
  }, {})

  return (families || []).map((family: any) => ({
    ...family,
    count: counts[family.key] || 0
  }))
}

async function getBlockVariantResults(family?: string) {
  if (!HAS_SUPABASE) {
    return listBlockVariants(family)
  }

  let query = supabaseAdmin
    .from('block_variants')
    .select('*, block_families(label, label_ja)')
    .order('family_key')

  if (family) query = query.eq('family_key', family)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data || []
}

async function deleteSectionRecord(sectionId: string) {
  if (!HAS_SUPABASE) {
    return deleteLocalSection(sectionId)
  }

  const { error } = await supabaseAdmin
    .from('source_sections')
    .delete()
    .eq('id', sectionId)

  if (error) throw new Error(error.message)
  return true
}

async function getDomRecord(sectionId: string) {
  if (!HAS_SUPABASE) {
    const snapshot = await getLatestResolvedSnapshot(sectionId)
    if (!snapshot) return null
    const nodes = await getSectionNodes(snapshot.id)
    return { snapshot, nodes }
  }

  const { data: snapshot } = await supabaseAdmin
    .from('section_dom_snapshots')
    .select('id, html_storage_path, dom_json_path, node_count, css_strategy')
    .eq('section_id', sectionId)
    .eq('snapshot_type', 'resolved')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!snapshot) return null

  const { data: nodes, error } = await supabaseAdmin
    .from('section_nodes')
    .select('*')
    .eq('snapshot_id', snapshot.id)
    .order('order_index')

  if (error) throw new Error(error.message)
  return { snapshot, nodes: nodes || [] }
}

async function createPatchSetRecord(sectionId: string, projectId?: string | null, label?: string | null) {
  if (!HAS_SUPABASE) {
    const snapshot = await getLatestResolvedSnapshot(sectionId)
    if (!snapshot) return null
    return createPatchSet({
      section_id: sectionId,
      project_id: projectId || null,
      base_snapshot_id: snapshot.id,
      label: label || null
    })
  }

  const { data: snapshot } = await supabaseAdmin
    .from('section_dom_snapshots')
    .select('id')
    .eq('section_id', sectionId)
    .eq('snapshot_type', 'resolved')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!snapshot) return null

  const { data, error } = await supabaseAdmin
    .from('section_patch_sets')
    .insert({
      section_id: sectionId,
      project_id: projectId || null,
      base_snapshot_id: snapshot.id,
      label: label || null
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

async function addPatchRecords(
  patchSetId: string,
  patches: Array<{ nodeStableKey: string; op: string; payload?: Record<string, any> }>
) {
  if (!HAS_SUPABASE) {
    return addPatches(patchSetId, patches)
  }

  const { data: existing } = await supabaseAdmin
    .from('section_patches')
    .select('order_index')
    .eq('patch_set_id', patchSetId)
    .order('order_index', { ascending: false })
    .limit(1)

  let nextIndex = (existing?.[0]?.order_index ?? -1) + 1

  const records = patches.map((patch: any) => ({
    patch_set_id: patchSetId,
    node_stable_key: patch.nodeStableKey,
    op: patch.op,
    payload_jsonb: patch.payload || {},
    order_index: nextIndex++
  }))

  const { data, error } = await supabaseAdmin
    .from('section_patches')
    .insert(records)
    .select()

  if (error) throw new Error(error.message)

  await supabaseAdmin
    .from('section_patch_sets')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', patchSetId)

  return data || []
}

async function getPatchSetRecord(patchSetId: string) {
  if (!HAS_SUPABASE) {
    const patchSet = await getPatchSet(patchSetId)
    if (!patchSet) return null
    const patches = await getPatches(patchSetId)
    return { patchSet, patches }
  }

  const { data: patchSet } = await supabaseAdmin
    .from('section_patch_sets')
    .select('*')
    .eq('id', patchSetId)
    .single()

  if (!patchSet) return null

  const { data: patches } = await supabaseAdmin
    .from('section_patches')
    .select('*')
    .eq('patch_set_id', patchSetId)
    .order('order_index')

  return { patchSet, patches: patches || [] }
}

async function createProjectPageBlockRecord(record: Record<string, any>) {
  if (!HAS_SUPABASE) {
    return createProjectPageBlock(record)
  }

  const { data, error } = await supabaseAdmin
    .from('project_page_blocks')
    .insert(record)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

async function getDefaultVariantRecord() {
  if (!HAS_SUPABASE) {
    return getDefaultBlockVariant()
  }

  const { data } = await supabaseAdmin
    .from('block_variants')
    .select('id')
    .limit(1)
    .single()

  return data || null
}

// ============================================================
// Clean asset serving: /assets/{siteId}/{jobId}/...
// ============================================================
app.get('/assets/:siteId/:jobId/*filePath', async (req, res) => {
  const { siteId, jobId } = req.params
  const filePath = Array.isArray(req.params.filePath)
    ? req.params.filePath.join('/')
    : req.params.filePath
  const storagePath = `${siteId}/${jobId}/${filePath}`

  // Determine content type from extension
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const contentTypes: Record<string, string> = {
    css: 'text/css',
    html: 'text/html',
    js: 'application/javascript',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',
    ico: 'image/x-icon',
    mp4: 'video/mp4',
    webm: 'video/webm',
  }
  const contentType = contentTypes[ext] || 'application/octet-stream'

  if (HAS_SUPABASE) {
    // Try all relevant buckets
    for (const bucket of [STORAGE_BUCKETS.RAW_HTML, STORAGE_BUCKETS.SANITIZED_HTML, STORAGE_BUCKETS.SECTION_THUMBNAILS, STORAGE_BUCKETS.PAGE_SCREENSHOTS]) {
      const { data, error } = await supabaseAdmin.storage.from(bucket).download(storagePath)
      if (data && !error) {
        const buffer = Buffer.from(await data.arrayBuffer())
        res.setHeader('Content-Type', contentType)
        res.setHeader('Cache-Control', 'public, max-age=86400')
        res.send(buffer)
        return
      }
    }
    res.status(404).send('Asset not found')
    return
  }

  // Local mode - try all relevant buckets
  const localBuckets = [
    STORAGE_BUCKETS.RAW_HTML,
    STORAGE_BUCKETS.SANITIZED_HTML,
    STORAGE_BUCKETS.SECTION_THUMBNAILS,
    STORAGE_BUCKETS.PAGE_SCREENSHOTS
  ]
  for (const bucket of localBuckets) {
    try {
      const { buffer, contentType: localContentType } = await getStoredFileResponse(bucket, storagePath)
      res.setHeader('Content-Type', localContentType)
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.send(buffer)
      return
    } catch {
      // try next bucket
    }
  }
  res.status(404).send('File not found')
})

// Legacy: /api/storage/:bucket (backward compat for old data)
app.get('/api/storage/:bucket', async (req, res) => {
  if (HAS_SUPABASE) {
    res.status(404).send('Not found')
    return
  }

  const storagePath = typeof req.query.path === 'string' ? req.query.path : ''
  if (!storagePath) {
    res.status(400).send('Missing path')
    return
  }

  try {
    const { buffer, contentType } = await getStoredFileResponse(req.params.bucket, storagePath)
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.send(buffer)
  } catch {
    res.status(404).send('File not found')
  }
})

// ============================================================
// Extract: Create a crawl job
// ============================================================
app.post('/api/extract', async (req, res) => {
  // Rate limit: max 10 extract requests per minute per IP
  const clientIp = req.ip || 'unknown'
  if (!rateLimit(`extract:${clientIp}`, 10, 60_000)) {
    res.status(429).json({ error: 'Too many requests. Please try again later.' })
    return
  }

  const { url, genre, tags, max_pages } = req.body
  if (!url || typeof url !== 'string' || !/^https?:\/\/.+/.test(url)) {
    res.status(400).json({ error: 'Valid URL (http/https) is required' })
    return
  }

  if (genre !== undefined && typeof genre !== 'string') {
    res.status(400).json({ error: 'genre must be a string' })
    return
  }

  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string')) {
      res.status(400).json({ error: 'tags must be an array of strings' })
      return
    }
  }

  if (max_pages !== undefined) {
    const parsed = Number(max_pages)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
      res.status(400).json({ error: 'max_pages must be an integer between 1 and 50' })
      return
    }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    res.status(400).json({ error: 'Invalid URL format' })
    return
  }

  try {
    const maxPagesNum = max_pages ? Number(max_pages) : 5
    const { site, job } = await createExtractJobRecord(url, genre || '', Array.isArray(tags) ? tags : [], maxPagesNum)

    res.json({ jobId: job.id, siteId: site.id, status: 'queued', maxPages: maxPagesNum })
  } catch (err: any) {
    logger.error('Extract job creation failed', { url, error: err.message })
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Job status
// ============================================================
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await getJobRecord(req.params.id)
    if (!job) {
      res.status(404).json({ error: 'Job not found' })
      return
    }
    res.json({ job })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Get sections for a crawl run (with signed thumbnail URLs)
// ============================================================
app.get('/api/jobs/:id/sections', async (req, res) => {
  try {
    const record = await getJobSectionsRecord(req.params.id)
    if (!record) {
      res.status(404).json({ error: 'Page not found for this job' })
      return
    }

    const sections = (record.sections || []).map((section: any) => ({
      ...section,
      htmlUrl: (section.sanitized_html_storage_path || section.raw_html_storage_path) ? `/api/sections/${section.id}/render` : null,
      thumbnailUrl: section.thumbnail_storage_path ? `/api/sections/${section.id}/thumbnail` : null
    }))

    res.json({ sections })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Thumbnail: Serve section thumbnail image
// ============================================================
app.get('/api/sections/:sectionId/thumbnail', async (req, res) => {
  const { sectionId } = req.params
  try {
    const section = await getSectionRecord(sectionId)
    if (!section?.thumbnail_storage_path) {
      res.status(404).send('No thumbnail')
      return
    }
    const file = await readBucketFile(STORAGE_BUCKETS.SECTION_THUMBNAILS, section.thumbnail_storage_path)
      || await readBucketFile(STORAGE_BUCKETS.RAW_HTML, section.thumbnail_storage_path)
    if (!file) {
      res.status(404).send('Thumbnail not found')
      return
    }
    res.setHeader('Content-Type', file.contentType || 'image/png')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(file.buffer)
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Render: Serve section HTML with inlined CSS
// ============================================================
app.get('/api/sections/:sectionId/render', async (req, res) => {
  const { sectionId } = req.params
  try {
    const prepared = await prepareSectionRender(sectionId)
    if (!prepared) {
      res.status(404).send('Section not found')
      return
    }

    const html = buildRenderDocument(renderPreparedSection(prepared), '', {
      skipBase: true,
      extraHead: buildStyleTags([
        PARTCOPY_BASE_CSS,
        ...prepared.fontFaceCss,
        prepared.css
      ])
    })

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(html)
  } catch (err: any) {
    res.status(500).send('Render failed')
  }
})

// ============================================================
// Preview: Render merged sections in a single document
// ============================================================
app.get('/api/preview/merged', async (req, res) => {
  const sectionIds = parseSectionIdsQuery(req.query.sections)
  if (sectionIds.length === 0) {
    res.status(400).json({ error: 'sections query is required' })
    return
  }

  try {
    const preparedSections = (
      await Promise.all(sectionIds.map((sectionId) => prepareSectionRender(sectionId)))
    ).filter((section): section is PreparedSectionRender => Boolean(section))

    if (preparedSections.length === 0) {
      res.status(404).send('No sections found')
      return
    }

    const mergedHtml = preparedSections.map(renderPreparedSection).join('\n')
    const mergedCss = preparedSections.map((section) => section.css)
    const mergedFontFaces = dedupeCssBlocks(preparedSections.flatMap((section) => section.fontFaceCss))

    const html = buildRenderDocument(`<main class="pc-preview-page">${mergedHtml}</main>`, '', {
      skipBase: true,
      extraHead: buildStyleTags([PARTCOPY_BASE_CSS, ...mergedFontFaces, ...mergedCss])
    })

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(html)
  } catch (err: any) {
    res.status(500).send('Merged preview failed')
  }
})

// ============================================================
// Library: Get all sections with filters
// ============================================================
const parseBooleanQuery = (value: unknown) => value === 'true' || value === '1'

const normalizeSearchValue = (value: unknown) => String(value || '').trim().toLowerCase()

app.get('/api/library', async (req, res) => {
  const {
    genre,
    family,
    industry,
    limit: lim,
    q,
    sort,
    hasCta,
    hasForm,
    hasImages
  } = req.query

  const limit = Math.min(Math.max(Number(lim) || 60, 1), 200)
  try {
    const results = await getLibraryResults({
      genre: typeof genre === 'string' ? genre : undefined,
      family: typeof family === 'string' ? family : undefined,
      industry: typeof industry === 'string' ? industry : undefined,
      limit,
      q: typeof q === 'string' ? q : undefined,
      sort: typeof sort === 'string' ? sort : 'newest',
      hasCta: parseBooleanQuery(hasCta),
      hasForm: parseBooleanQuery(hasForm),
      hasImages: parseBooleanQuery(hasImages)
    })

    res.json({
      sections: results.map((section: any) => ({
        ...section,
        htmlUrl: (section.sanitized_html_storage_path || section.raw_html_storage_path) ? `/api/sections/${section.id}/render` : null,
        thumbnailUrl: section.thumbnail_storage_path ? `/api/sections/${section.id}/thumbnail` : null
      }))
    })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Library: Genre summary
// ============================================================
app.get('/api/library/genres', async (req, res) => {
  try {
    res.json({ genres: await getGenreResults() })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Library: Block family summary
// ============================================================
app.get('/api/library/families', async (req, res) => {
  try {
    res.json({ families: await getFamilyResults() })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Block variants
// ============================================================
app.get('/api/block-variants', async (req, res) => {
  try {
    res.json({ variants: await getBlockVariantResults(typeof req.query.family === 'string' ? req.query.family : undefined) })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Delete section from library
// ============================================================
app.delete('/api/library/:id', async (req, res) => {
  try {
    const section = await getSectionRecord(req.params.id)
    if (section && HAS_SUPABASE) {
      const paths = [
        section.raw_html_storage_path,
        section.sanitized_html_storage_path,
        section.thumbnail_storage_path
      ].filter(Boolean)
      for (const p of paths) {
        await supabaseAdmin.storage.from(STORAGE_BUCKETS.RAW_HTML).remove([p]).catch(() => {})
      }
    }
    await deleteSectionRecord(req.params.id)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Source Edit: Get DOM nodes for a section
// ============================================================
app.get('/api/sections/:sectionId/dom', async (req, res) => {
  const { sectionId } = req.params
  try {
    const record = await getDomRecord(sectionId)
    if (!record) {
      res.status(404).json({ error: 'No editable snapshot found' })
      return
    }

    res.json({
      snapshotId: record.snapshot.id,
      htmlStoragePath: record.snapshot.html_storage_path,
      nodeCount: record.snapshot.node_count,
      nodes: record.nodes || []
    })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Source Edit: Get / Update raw HTML for code editing
// ============================================================
async function getSectionRecord(sectionId: string) {
  if (!HAS_SUPABASE) {
    return getSection(sectionId)
  }
  const { data, error } = await supabaseAdmin
    .from('source_sections')
    .select('*')
    .eq('id', sectionId)
    .single()
  if (error) return null
  return data
}

app.get('/api/sections/:sectionId/html', async (req, res) => {
  const { sectionId } = req.params
  try {
    const section = await getSectionRecord(sectionId)
    if (!section?.raw_html_storage_path) {
      res.status(404).json({ error: 'Section not found' })
      return
    }
    const html = await readBucketText(STORAGE_BUCKETS.RAW_HTML, section.raw_html_storage_path)
    res.json({ html, storagePath: section.raw_html_storage_path })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

app.put('/api/sections/:sectionId/html', async (req, res) => {
  const { sectionId } = req.params
  const { html } = req.body
  if (typeof html !== 'string' || html.trim().length === 0) {
    res.status(400).json({ error: 'html must be a non-empty string' })
    return
  }
  try {
    const section = await getSectionRecord(sectionId)
    if (!section?.raw_html_storage_path) {
      res.status(404).json({ error: 'Section not found' })
      return
    }
    if (HAS_SUPABASE) {
      const buffer = Buffer.from(html, 'utf-8')
      const { error } = await supabaseAdmin.storage
        .from(STORAGE_BUCKETS.RAW_HTML)
        .upload(section.raw_html_storage_path, buffer, { contentType: 'text/html', upsert: true })
      if (error) throw new Error(error.message)
    } else {
      const { writeStoredFile } = await import('./local-store.js')
      await writeStoredFile(
        STORAGE_BUCKETS.RAW_HTML,
        section.raw_html_storage_path,
        Buffer.from(html, 'utf-8'),
        'text/html'
      )
    }
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Section: Create custom (手動追加)
// ============================================================
app.post('/api/sections/custom', async (req, res) => {
  const { html, blockFamily, textSummary } = req.body
  if (typeof html !== 'string' || html.trim().length === 0) {
    res.status(400).json({ error: 'html must be a non-empty string' })
    return
  }
  try {
    const { randomUUID } = await import('crypto')
    const sectionId = randomUUID()
    const storagePath = `custom/${sectionId}/raw.html`
    const family = blockFamily || 'CUSTOM'
    const summary = textSummary || html.replace(/<[^>]*>/g, '').slice(0, 500)

    // カスタムセクション用のダミーサイト・ページを取得 or 作成
    const customDomain = 'custom.local'

    if (HAS_SUPABASE) {
      // Ensure custom site exists
      let { data: site } = await supabaseAdmin.from('source_sites').select('id').eq('normalized_domain', customDomain).single()
      if (!site) {
        const { data: newSite, error: siteErr } = await supabaseAdmin.from('source_sites').insert({ normalized_domain: customDomain, homepage_url: 'custom://local' }).select('id').single()
        if (siteErr) throw new Error(siteErr.message)
        site = newSite
      }
      // Ensure custom page exists
      let { data: page } = await supabaseAdmin.from('source_pages').select('id').eq('url', 'custom://local').single()
      if (!page) {
        // Need a crawl_run first
        const { data: run, error: runErr } = await supabaseAdmin.from('crawl_runs').insert({ site_id: site!.id, status: 'done', trigger_type: 'manual' }).select('id').single()
        if (runErr) throw new Error(runErr.message)
        const { data: newPage, error: pageErr } = await supabaseAdmin.from('source_pages').insert({ crawl_run_id: run!.id, url: 'custom://local', path: '/', title: 'Custom Sections', site_id: site!.id }).select('id').single()
        if (pageErr) throw new Error(pageErr.message)
        page = newPage
      }

      const buffer = Buffer.from(html, 'utf-8')
      const { error: uploadErr } = await supabaseAdmin.storage
        .from(STORAGE_BUCKETS.RAW_HTML)
        .upload(storagePath, buffer, { contentType: 'text/html', upsert: true })
      if (uploadErr) throw new Error(uploadErr.message)

      const { data, error } = await supabaseAdmin
        .from('source_sections')
        .insert({
          id: sectionId,
          page_id: page!.id,
          site_id: site!.id,
          block_family: family,
          classifier_type: 'manual',
          classifier_confidence: 1.0,
          raw_html_storage_path: storagePath,
          text_summary: summary,
          tag_name: 'section',
          order_index: 0,
          features_jsonb: {}
        })
        .select('*')
        .single()
      if (error) throw new Error(error.message)
      res.json({ section: data })
    } else {
      const { writeStoredFile, createSourceSection, createSourcePage, upsertSourceSite: localUpsertSite, createCrawlRun: localCreateRun } = await import('./local-store.js')

      // Ensure custom site + page
      const site = await localUpsertSite({
        normalized_domain: customDomain,
        homepage_url: 'custom://local',
        status: 'done'
      })
      const { getPageByUrl } = await import('./local-store.js')
      let page: any = null
      try { page = await getPageByUrl?.('custom://local') } catch {}
      if (!page) {
        const run = await localCreateRun({ site_id: site.id, trigger_type: 'manual', status: 'done' })
        page = await createSourcePage({ crawl_run_id: run.id, url: 'custom://local', title: 'Custom Sections', site_id: site.id } as any)
      }

      await writeStoredFile(STORAGE_BUCKETS.RAW_HTML, storagePath, Buffer.from(html, 'utf-8'), 'text/html')
      const row = await createSourceSection({
        page_id: page.id,
        site_id: site.id,
        block_family: family,
        classifier_type: 'manual',
        classifier_confidence: 1.0,
        raw_html_storage_path: storagePath,
        text_summary: summary,
        tag_name: 'section',
        order_index: 0,
        features_jsonb: {}
      } as any)
      res.json({ section: row })
    }
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Section: Delete
// ============================================================
app.delete('/api/sections/:sectionId', async (req, res) => {
  const { sectionId } = req.params
  try {
    // Optionally clean up storage files
    const section = await getSectionRecord(sectionId)
    if (section && HAS_SUPABASE) {
      const paths = [
        section.raw_html_storage_path,
        section.sanitized_html_storage_path,
        section.thumbnail_storage_path
      ].filter(Boolean)
      for (const p of paths) {
        await supabaseAdmin.storage.from(STORAGE_BUCKETS.RAW_HTML).remove([p]).catch(() => {})
      }
    }
    await deleteSectionRecord(sectionId)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Source Edit: Render resolved HTML (with data-pc-key attributes)
// ============================================================
app.get('/api/sections/:sectionId/editable-render', async (req, res) => {
  const { sectionId } = req.params
  try {
    const record = await getRenderContext(sectionId)
    if (!record?.resolvedSnapshot?.html_storage_path) {
      res.status(404).send('No editable snapshot')
      return
    }

    let pageOrigin = ''
    try { if (record.page.url) pageOrigin = new URL(record.page.url).origin } catch {}

    let sectionHtml = await readBucketText(STORAGE_BUCKETS.SANITIZED_HTML, record.resolvedSnapshot.html_storage_path)
    if (!sectionHtml) {
      res.status(404).send('HTML not found')
      return
    }

    // Inline CSS content directly (the /assets/ link path doesn't resolve)
    let cssContent = ''
    if (record.page.css_bundle_path) {
      cssContent = await readBucketText(STORAGE_BUCKETS.SANITIZED_HTML, record.page.css_bundle_path)
      if (!cssContent) {
        cssContent = await readBucketText(STORAGE_BUCKETS.RAW_HTML, record.page.css_bundle_path)
      }
    }
    // Rewrite relative font/image URLs in CSS to absolute /assets/ paths
    if (cssContent && record.page.css_bundle_path) {
      const assetBase = '/assets/' + record.page.css_bundle_path.replace(/\/[^/]+$/, '/')
      cssContent = cssContent.replace(
        /url\(\s*(['"]?)((?:(?!\1\)).)*?)\1\s*\)/gi,
        (match, q, rawPath) => {
          const trimmed = rawPath.trim()
          // Skip data URIs, absolute URLs, already-prefixed paths
          if (!trimmed || /^(data:|https?:\/\/|\/\/|\/assets\/)/i.test(trimmed)) {
            return match
          }
          return `url(${q}${assetBase}${trimmed}${q})`
        }
      )
    }
    const cssStyle = cssContent ? `<style>${cssContent}</style>` : ''

  // 編集UIとの通信用スクリプト
  const editorScript = `
<script>
  // ノードクリック時に親ウィンドウにメッセージ送信
  document.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var target = e.target;
    while (target && !target.dataset.pcKey) {
      target = target.parentElement;
    }
    if (target && target.dataset.pcKey) {
      window.parent.postMessage({
        type: 'pc:node-click',
        stableKey: target.dataset.pcKey,
        tagName: target.tagName.toLowerCase(),
        textContent: (target.textContent || '').slice(0, 500),
        rect: target.getBoundingClientRect().toJSON()
      }, '*');
    }
  });
  // ホバーハイライト
  document.addEventListener('mouseover', function(e) {
    var target = e.target;
    while (target && !target.dataset.pcKey) {
      target = target.parentElement;
    }
    document.querySelectorAll('[data-pc-highlight]').forEach(function(el) {
      el.removeAttribute('data-pc-highlight');
      el.style.outline = '';
    });
    if (target && target.dataset.pcKey) {
      target.setAttribute('data-pc-highlight', 'true');
      target.style.outline = '2px solid #3b82f6';
    }
  });
  // 親からのパッチメッセージ受信
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'pc:apply-patch') return;
    var patch = e.data.patch;
    var el = document.querySelector('[data-pc-key="' + patch.nodeStableKey + '"]');
    if (!el) return;
    switch (patch.op) {
      case 'set_text': el.textContent = patch.payload.text; break;
      case 'set_attr': el.setAttribute(patch.payload.attr, patch.payload.value); break;
      case 'replace_asset':
        if (el.tagName === 'IMG') { el.src = patch.payload.src; if (patch.payload.alt) el.alt = patch.payload.alt; }
        break;
      case 'set_style_token': el.style.setProperty(patch.payload.property, patch.payload.value); break;
      case 'remove_node': el.remove(); break;
    }
    window.parent.postMessage({ type: 'pc:patch-applied', stableKey: patch.nodeStableKey }, '*');
  });
</script>`

    sectionHtml = resolveRelativeUrls(sectionHtml, pageOrigin)

    const html = buildRenderDocument(sectionHtml, pageOrigin, {
      skipBase: true,
      extraHead: `${cssStyle}<style>
  [data-pc-key] { cursor: pointer; transition: outline 0.15s; }
  [data-pc-key]:hover { outline: 2px solid rgba(59,130,246,0.4); }
  [data-pc-selected] { outline: 2px solid #3b82f6 !important; box-shadow: 0 0 0 4px rgba(59,130,246,0.15); }
</style>`,
      extraBodyEnd: editorScript
    })

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  } catch (err: any) {
    res.status(500).send('Editable render failed')
  }
})

// ============================================================
// Patch Sets: Create
// ============================================================
app.post('/api/sections/:sectionId/patch-sets', async (req, res) => {
  const { sectionId } = req.params
  const { projectId, label } = req.body

  if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
    res.status(400).json({ error: 'projectId must be a string if provided' })
    return
  }
  if (label !== undefined && label !== null && typeof label !== 'string') {
    res.status(400).json({ error: 'label must be a string if provided' })
    return
  }

  try {
    const patchSet = await createPatchSetRecord(sectionId, projectId || null, label || null)
    if (!patchSet) {
      res.status(404).json({ error: 'No snapshot found' })
      return
    }
    res.json({ patchSet })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Patch Sets: Add patches
// ============================================================
app.post('/api/patch-sets/:patchSetId/patches', async (req, res) => {
  const { patchSetId } = req.params
  const { patches } = req.body // Array of { nodeStableKey, op, payload }

  if (!Array.isArray(patches) || patches.length === 0) {
    res.status(400).json({ error: 'patches array is required' })
    return
  }

  // Validate each patch
  const VALID_OPS = ['set_text', 'set_attr', 'replace_asset', 'remove_node', 'insert_after', 'move_node', 'set_style_token', 'set_class']
  for (const p of patches) {
    if (!p.nodeStableKey || typeof p.nodeStableKey !== 'string') {
      res.status(400).json({ error: 'Each patch must have a nodeStableKey string' })
      return
    }
    if (!p.op || typeof p.op !== 'string' || !VALID_OPS.includes(p.op)) {
      res.status(400).json({ error: `Invalid op "${p.op}". Must be one of: ${VALID_OPS.join(', ')}` })
      return
    }
    // Ops that require a payload object
    const OPS_REQUIRING_PAYLOAD = ['set_text', 'set_attr', 'replace_asset', 'set_style_token', 'set_class', 'insert_after']
    if (OPS_REQUIRING_PAYLOAD.includes(p.op) && (!p.payload || typeof p.payload !== 'object')) {
      res.status(400).json({ error: `Op "${p.op}" requires a payload object` })
      return
    }
    // Block dangerous attrs
    if (p.op === 'set_attr' && /^on/i.test(p.payload?.attr)) {
      res.status(400).json({ error: 'Event handler attributes are not allowed' })
      return
    }
  }

  try {
    const created = await addPatchRecords(patchSetId, patches)
    if (!created) {
      res.status(404).json({ error: 'Patch set not found' })
      return
    }
    res.json({ patches: created })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Patch Sets: Get all patches for a set
// ============================================================
app.get('/api/patch-sets/:patchSetId', async (req, res) => {
  const { patchSetId } = req.params
  try {
    const record = await getPatchSetRecord(patchSetId)
    if (!record) {
      res.status(404).json({ error: 'Patch set not found' })
      return
    }
    res.json(record)
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Project Page Blocks: CRUD
// ============================================================
app.post('/api/projects/:projectId/page-blocks', async (req, res) => {
  const { projectId } = req.params
  const { pageId, sectionId, patchSetId, blockInstanceId, renderMode, position } = req.body

  const record: any = {
    project_page_id: pageId,
    position: position ?? 0,
    render_mode: renderMode || 'source_patch'
  }

  if (renderMode === 'source_patch') {
    record.source_section_id = sectionId
    record.patch_set_id = patchSetId || null
    const defaultVariant = await getDefaultVariantRecord()
    record.block_variant_id = defaultVariant?.id
  } else {
    record.source_block_instance_id = blockInstanceId
    const instance = HAS_SUPABASE
      ? (await supabaseAdmin
        .from('block_instances')
        .select('block_variant_id')
        .eq('id', blockInstanceId)
        .single()).data
      : await getBlockInstance(blockInstanceId)
    record.block_variant_id = instance?.block_variant_id
  }

  try {
    const block = await createProjectPageBlockRecord(record)
    res.json({ block })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Claude TSX conversion
// ============================================================
app.post('/api/sections/:sectionId/convert-tsx', async (req, res) => {
  const { sectionId } = req.params
  try {
    const ctx = await getRenderContext(sectionId)
    if (!ctx) {
      res.status(404).json({ error: 'Section not found' })
      return
    }

    // Get raw HTML
    let html = await readBucketText(STORAGE_BUCKETS.RAW_HTML, ctx.section.raw_html_storage_path)
    if (!html) {
      html = await readBucketText(STORAGE_BUCKETS.SANITIZED_HTML, ctx.section.sanitized_html_storage_path)
    }
    if (!html) {
      res.status(404).json({ error: 'Section HTML not found' })
      return
    }

    // Get block family for component naming
    let blockFamily: string | undefined
    if (HAS_SUPABASE) {
      const { data } = await supabaseAdmin
        .from('source_sections')
        .select('block_family')
        .eq('id', sectionId)
        .single()
      blockFamily = data?.block_family
    } else {
      const section = await getSection(sectionId)
      blockFamily = section?.block_family
    }

    // Load CSS and scope it
    const scopeClass = createSectionScopeClass(sectionId)
    const cssBundle = await loadSectionCssBundle(ctx.page?.css_bundle_path)
    const { scopedCss, fontFaceCss } = scopeCss(cssBundle, scopeClass)
    const allCss = [...fontFaceCss, scopedCss].filter(Boolean).join('\n')

    // Wrap HTML with scope class
    const scopedHtml = `<div className="${scopeClass}">\n${html}\n</div>`

    const tsx = await convertHtmlToTsx(scopedHtml, blockFamily)

    // Return TSX without double-injecting CSS (Claude's output already contains <style> blocks)
    res.json({ tsx, blockFamily, scopeClass })
  } catch (err: any) {
    logger.error('TSX conversion failed', { sectionId, error: err.message })
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Get stored TSX code
// ============================================================
app.get('/api/sections/:sectionId/tsx', async (req, res) => {
  const { sectionId } = req.params
  try {
    let tsxPath: string | undefined
    let blockFamily: string | undefined

    if (HAS_SUPABASE) {
      const { data } = await supabaseAdmin
        .from('source_sections')
        .select('tsx_code_storage_path, block_family')
        .eq('id', sectionId)
        .single()
      tsxPath = data?.tsx_code_storage_path
      blockFamily = data?.block_family
    } else {
      const section = await getSection(sectionId)
      tsxPath = section?.tsx_code_storage_path
      blockFamily = section?.block_family
    }

    if (!tsxPath) {
      res.status(404).json({ error: 'TSX not yet generated for this section' })
      return
    }

    const tsx = await readBucketText(STORAGE_BUCKETS.SANITIZED_HTML, tsxPath)
    if (!tsx) {
      res.status(404).json({ error: 'TSX file not found' })
      return
    }

    res.json({ tsx, blockFamily })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// ZIP Export - combine canvas sections into a downloadable project
// ============================================================
app.post('/api/export/zip', async (req, res) => {
  const { sectionIds, includeImages = true } = req.body as { sectionIds: string[]; includeImages?: boolean }

  if (!sectionIds || !Array.isArray(sectionIds) || sectionIds.length === 0) {
    res.status(400).json({ error: 'sectionIds array required' })
    return
  }

  try {
    const preparedSections: PreparedSectionRender[] = []
    for (const sectionId of sectionIds) {
      const prepared = await prepareSectionRender(sectionId)
      if (prepared) preparedSections.push(prepared)
    }

    if (preparedSections.length === 0) {
      res.status(404).json({ error: 'No exportable sections found' })
      return
    }

    const exportAssetPathBySource = new Map<string, string>()
    const exportAssetPathByKey = new Map<string, string>()
    const exportAssets: ExportAssetFile[] = []
    const componentCounts = new Map<string, number>()
    const globalFontFaceCss: string[] = []
    const failedAssetUrls = new Set<string>()

    function escapeStringForRegex(str: string) {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm)(\?[^'"]*)?$/i

    const ensureExportAsset = async (sourceUrl: string) => {
      if (exportAssetPathBySource.has(sourceUrl)) {
        return exportAssetPathBySource.get(sourceUrl)
      }

      // Skip image assets when includeImages is false
      if (!includeImages && IMAGE_EXT_RE.test(sourceUrl)) {
        exportAssetPathBySource.set(sourceUrl, '/assets/placeholder.svg')
        return '/assets/placeholder.svg'
      }

      const resolvedAsset = await loadExportAssetSource(sourceUrl)
      if (!resolvedAsset) {
        failedAssetUrls.add(sourceUrl)
        return undefined
      }

      // Also check content-type for image assets when includeImages is false
      if (!includeImages && resolvedAsset.contentType?.startsWith('image/')) {
        exportAssetPathBySource.set(sourceUrl, '/assets/placeholder.svg')
        return '/assets/placeholder.svg'
      }

      let exportPath = exportAssetPathByKey.get(resolvedAsset.key)
      if (!exportPath) {
        const fileName = buildExportAssetFileName(
          resolvedAsset.key,
          sourceUrl,
          resolvedAsset.contentType,
          resolvedAsset.fileNameHint
        )
        exportPath = `/assets/${fileName}`
        exportAssetPathByKey.set(resolvedAsset.key, exportPath)
        exportAssets.push({
          exportPath,
          buffer: resolvedAsset.buffer
        })
      }

      exportAssetPathBySource.set(sourceUrl, exportPath)
      return exportPath
    }

    const components: { name: string; tsx: string; blockFamily: string; cssFile?: string }[] = []

    // Regex to collect absolute URLs from TSX string literals (both single and double quoted)
    const TSX_URL_RE = /(?:['"])(https?:\/\/[^'"\s]+)(?:['"])/g

    function collectTsxAssetUrls(tsxCode: string) {
      const urls: string[] = []
      let m: RegExpExecArray | null
      const re = new RegExp(TSX_URL_RE.source, TSX_URL_RE.flags)
      while ((m = re.exec(tsxCode)) !== null) {
        const url = m[1]
        // Only collect URLs that look like assets (images, fonts, media)
        if (/\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm)(\?[^'"]*)?$/i.test(url)) {
          urls.push(url)
        }
      }
      return dedupeStrings(urls)
    }

    function rewriteTsxAssetUrls(tsxCode: string, replacer: (url: string) => string | undefined) {
      return tsxCode.replace(
        /(['"])(https?:\/\/[^'"\s]+)\1/g,
        (match, quote, url) => {
          const rewritten = replacer(url)
          if (!rewritten) return match
          return `${quote}${rewritten}${quote}`
        }
      )
    }

    function renameTsxDefaultExport(tsxCode: string, newName: string) {
      // Handle: export default function Xxx(...)
      let result = tsxCode.replace(
        /export\s+default\s+function\s+\w+/,
        `export default function ${newName}`
      )
      // Handle: const Xxx: React.FC = ... then export default Xxx
      // Replace the const declaration name and the export default reference
      const constMatch = result.match(/const\s+(\w+)\s*:\s*React\.FC/)
      if (constMatch) {
        const oldName = constMatch[1]
        result = result.replace(
          new RegExp(`const\\s+${oldName}\\s*:`),
          `const ${newName}:`
        )
        result = result.replace(
          new RegExp(`export\\s+default\\s+${oldName}\\s*;?\\s*$`, 'm'),
          `export default ${newName};`
        )
      }
      return result
    }

    // Collect section screenshots for reference
    const sectionScreenshots: { name: string; buffer: Buffer }[] = []

    for (const prepared of preparedSections) {
      // Determine component name
      const componentBaseName = `${toPascalCase(prepared.blockFamily)}Section`
      const duplicateIndex = componentCounts.get(componentBaseName) || 0
      componentCounts.set(componentBaseName, duplicateIndex + 1)
      const componentName = duplicateIndex === 0 ? componentBaseName : `${componentBaseName}${duplicateIndex}`

      // Load section screenshot for reference
      let thumbnailPath: string | undefined
      if (HAS_SUPABASE) {
        const { data: secData } = await supabaseAdmin
          .from('source_sections')
          .select('thumbnail_storage_path')
          .eq('id', prepared.sectionId)
          .single()
        thumbnailPath = secData?.thumbnail_storage_path ?? undefined
      } else {
        const secRecord = await getSection(prepared.sectionId)
        thumbnailPath = secRecord?.thumbnail_storage_path ?? undefined
      }
      if (thumbnailPath) {
        const thumbFile = await readBucketFile(STORAGE_BUCKETS.SECTION_THUMBNAILS, thumbnailPath)
          || await readBucketFile(STORAGE_BUCKETS.RAW_HTML, thumbnailPath)
        if (thumbFile) {
          sectionScreenshots.push({ name: componentName, buffer: thumbFile.buffer })
        }
      }

      // Check if this section has Claude-converted TSX available
      let tsxStoragePath: string | undefined
      if (HAS_SUPABASE) {
        const { data } = await supabaseAdmin
          .from('source_sections')
          .select('tsx_code_storage_path')
          .eq('id', prepared.sectionId)
          .single()
        tsxStoragePath = data?.tsx_code_storage_path ?? undefined
      } else {
        const section = await getSection(prepared.sectionId)
        tsxStoragePath = section?.tsx_code_storage_path ?? undefined
      }

      let storedTsx = ''
      if (tsxStoragePath) {
        storedTsx = await readBucketText(STORAGE_BUCKETS.SANITIZED_HTML, tsxStoragePath)
      }

      if (storedTsx) {
        // --- TSX path: use Claude-converted component ---

        // Collect asset URLs from the TSX code and from font-face CSS
        const tsxAssetUrls = collectTsxAssetUrls(storedTsx)
        const fontAssetUrls = prepared.fontFaceCss.flatMap((block) => collectCssAssetUrls(block))
        const allAssetUrls = dedupeStrings([...tsxAssetUrls, ...fontAssetUrls])

        for (const sourceUrl of allAssetUrls) {
          await ensureExportAsset(sourceUrl)
        }

        // Rewrite absolute URLs in TSX to /assets/ relative paths
        let tsx = rewriteTsxAssetUrls(storedTsx, (url) => exportAssetPathBySource.get(url))

        // Remove references to failed assets (replace with empty placeholder comment)
        for (const failedUrl of failedAssetUrls) {
          tsx = tsx.replace(new RegExp(escapeStringForRegex(failedUrl), 'g'), '/assets/placeholder.svg')
        }

        // Rename the default export to match our component naming
        tsx = renameTsxDefaultExport(tsx, componentName)

        // Still collect font-face CSS for index.css
        const fontFaceCss = prepared.fontFaceCss.map((block) => rewriteCssUrls(block, (url) => exportAssetPathBySource.get(url)))
        globalFontFaceCss.push(...fontFaceCss)

        components.push({ name: componentName, tsx, blockFamily: prepared.blockFamily })
      } else {
        // --- Fallback: structured HTML with separate CSS file ---

        const sectionAssetUrls = dedupeStrings([
          ...collectHtmlAssetUrls(prepared.html),
          ...collectCssAssetUrls(prepared.css),
          ...prepared.fontFaceCss.flatMap((block) => collectCssAssetUrls(block))
        ])

        for (const sourceUrl of sectionAssetUrls) {
          await ensureExportAsset(sourceUrl)
        }

        let html = rewriteHtmlAssetUrls(prepared.html, (url) => exportAssetPathBySource.get(url))
        // Replace failed asset URLs with placeholder
        for (const failedUrl of failedAssetUrls) {
          html = html.replace(new RegExp(escapeStringForRegex(failedUrl), 'g'), '/assets/placeholder.svg')
        }
        const css = rewriteCssUrls(prepared.css, (url) => exportAssetPathBySource.get(url))
        const fontFaceCss = prepared.fontFaceCss.map((block) => rewriteCssUrls(block, (url) => exportAssetPathBySource.get(url)))
        globalFontFaceCss.push(...fontFaceCss)

        // Strip video elements from fallback HTML
        html = stripVideoElements(html)

        // Extract texts and images for edit guide
        const extractedTexts = extractTextsForGuide(html)
        const extractedImages = extractImagesForGuide(html)

        const jsxContent = htmlToJsx(html)

        // Generate edit guide comment
        const guideTexts = extractedTexts.map(t => ` * - "${t}"`).join('\n')
        const guideImages = extractedImages.map(t => ` * - ${t}`).join('\n')
        const editGuide = `/*
 * ========================================
 * 編集ガイド - ${componentName}
 * ========================================
 *
 * 【テキスト一覧】（JSX内で直接編集可能）
${guideTexts || ' * （テキストなし）'}
 *
 * 【画像パス一覧】
${guideImages || ' * （画像なし）'}
 *
 * 【編集方法】
 * - テキスト: JSX内のテキストを直接編集
 * - 画像: src属性のパスを変更（public/assets/に配置）
 * - スタイル: ${componentName}.css を編集
 * - レイアウト: CSS内の該当クラスを修正
 */`

        const tsx = `import './${componentName}.css'\n\n${editGuide}\n\nexport default function ${componentName}() {\n  return (\n    <section\n      className="${prepared.scopeClass}"\n      data-partcopy-section="${prepared.sectionId}"\n    >\n${jsxContent.split('\n').map(l => '      ' + l).join('\n')}\n    </section>\n  )\n}\n`

        // Store CSS separately
        const componentCssContent = `/* ${componentName} - Scoped CSS (auto-generated by PARTCOPY) */\n/* セクションスコープ: .${prepared.scopeClass} */\n\n${css}\n`

        components.push({ name: componentName, tsx, blockFamily: prepared.blockFamily, cssFile: componentCssContent })
      }
    }

    const blockFamilyJa: Record<string, string> = {
      navigation: 'ナビゲーション',
      hero: 'ヒーロー',
      feature: '特徴・サービス',
      social_proof: '導入実績・信頼',
      stats: '数字・実績',
      pricing: '料金プラン',
      faq: 'よくある質問',
      content: 'コンテンツ',
      cta: 'CTA（行動喚起）',
      contact: 'お問い合わせ',
      recruit: '採用',
      footer: 'フッター',
      news_list: 'お知らせ',
      timeline: '沿革・タイムライン',
      company_profile: '会社概要',
      gallery: 'ギャラリー',
      logo_cloud: 'ロゴ一覧',
      section: 'セクション',
      CUSTOM: 'カスタム'
    }

    // --- Multi-page React Router structure ---
    const componentImports = components.map(c => `import ${c.name} from './components/${c.name}'`).join('\n')
    const allSectionsRender = components.map(c => `      <${c.name} />`).join('\n')

    // Generate slug for each component
    const componentSlugs = components.map(c => {
      const slug = c.name.replace(/Section\d*$/, '').replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')
      return { ...c, slug }
    })

    const routeImports = componentSlugs.map(c =>
      `  { path: '/${c.slug}', element: <${c.name} />, label: '${blockFamilyJa[c.blockFamily] || c.blockFamily}', name: '${c.name}' }`
    ).join(',\n')

    const layoutTsx = `import { NavLink, Outlet } from 'react-router-dom'

interface RouteInfo {
  path: string
  label: string
  name: string
}

export default function Layout({ routes }: { routes: RouteInfo[] }) {
  return (
    <div className="pc-layout">
      <nav className="pc-sidebar">
        <div className="pc-sidebar-header">
          <h1>PARTCOPY</h1>
        </div>
        <ul className="pc-sidebar-nav">
          <li>
            <NavLink to="/" end className={({ isActive }) => isActive ? 'active' : ''}>
              すべて表示
            </NavLink>
          </li>
          {routes.map(r => (
            <li key={r.path}>
              <NavLink to={r.path} className={({ isActive }) => isActive ? 'active' : ''}>
                {r.label}
                <span className="pc-nav-component">{r.name}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="pc-main">
        <Outlet />
      </main>
    </div>
  )
}
`

    const homeTsx = `${componentImports}

export default function Home() {
  return (
    <div className="pc-preview-page">
${allSectionsRender}
    </div>
  )
}
`

    const appTsx = `import { BrowserRouter, Routes, Route } from 'react-router-dom'
${componentImports}
import Layout from './Layout'
import Home from './pages/Home'

const routes = [
${routeImports}
]

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout routes={routes} />}>
          <Route index element={<Home />} />
${componentSlugs.map(c => `          <Route path="/${c.slug}" element={<${c.name} />} />`).join('\n')}
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
`

    const indexTsx = `import ReactDOM from 'react-dom/client'\nimport './index.css'\nimport App from './App'\n\nReactDOM.createRoot(document.getElementById('root')!).render(<App />)\n`

    const pkgJson = JSON.stringify({
      name: 'partcopy-export',
      private: true,
      version: '1.0.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'tsc -b && vite build'
      },
      dependencies: {
        react: '^19.2.4',
        'react-dom': '^19.2.4',
        'react-router-dom': '^7.5.0'
      },
      devDependencies: {
        '@types/react': '^19.2.14',
        '@types/react-dom': '^19.2.3',
        '@vitejs/plugin-react': '^4.3.4',
        '@tailwindcss/vite': '^4.1.0',
        tailwindcss: '^4.1.0',
        typescript: '^5.6.0',
        vite: '^6.0.0'
      }
    }, null, 2)

    const indexHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PARTCOPY Export</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/index.tsx"></script>
</body>
</html>
`

    const tsconfigJson = JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        useDefineForClassFields: true,
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        skipLibCheck: true,
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        isolatedModules: true,
        moduleDetection: 'force',
        noEmit: true,
        jsx: 'react-jsx',
        strict: true,
        noUnusedLocals: false,
        noUnusedParameters: false
      },
      include: ['src']
    }, null, 2)

    const viteConfig = `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nimport tailwindcss from '@tailwindcss/vite'\n\nexport default defineConfig({\n  plugins: [react(), tailwindcss()],\n})\n`

    // Extract design tokens from all component CSS
    const allComponentCss = components.map(c => c.cssFile || '').join('\n') + '\n' + globalFontFaceCss.join('\n')
    const extractedColors = extractColorsFromCss(allComponentCss)
    const extractedFonts = extractFontsFromCss(allComponentCss)
    const designTokensCss = generateDesignTokensCss(extractedColors, extractedFonts)
    const brandGuide = generateBrandGuide(extractedColors, extractedFonts)

    const layoutCss = `
/* Layout */
.pc-layout {
  display: flex;
  min-height: 100vh;
}
.pc-sidebar {
  width: 240px;
  background: #111;
  color: #fff;
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  overflow-y: auto;
  z-index: 100;
}
.pc-sidebar-header {
  padding: 20px;
  border-bottom: 1px solid #333;
}
.pc-sidebar-header h1 {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.05em;
}
.pc-sidebar-nav {
  list-style: none;
  padding: 12px 0;
  margin: 0;
}
.pc-sidebar-nav li a {
  display: flex;
  flex-direction: column;
  padding: 10px 20px;
  color: #aaa;
  text-decoration: none;
  font-size: 13px;
  transition: all 0.15s;
  border-left: 3px solid transparent;
}
.pc-sidebar-nav li a:hover {
  color: #fff;
  background: rgba(255,255,255,0.05);
}
.pc-sidebar-nav li a.active {
  color: #fff;
  background: rgba(255,255,255,0.08);
  border-left-color: #10b981;
}
.pc-nav-component {
  font-size: 10px;
  color: #666;
  margin-top: 2px;
}
.pc-main {
  margin-left: 240px;
  flex: 1;
  min-width: 0;
}
`

    const indexCss = `@import 'tailwindcss';\n@import './design-tokens.css';\n\n${dedupeCssBlocks([PARTCOPY_BASE_CSS, layoutCss, ...globalFontFaceCss]).join('\n\n')}\n`

    // Generate setup.sh
    const setupSh = `#!/bin/bash
echo "================================"
echo "  PARTCOPY Export セットアップ"
echo "================================"
echo ""

# Node.js チェック
if ! command -v node &> /dev/null; then
  echo "エラー: Node.js がインストールされていません"
  echo "https://nodejs.org/ からインストールしてください"
  exit 1
fi

echo "1/3 依存関係をインストール中..."
npm install

echo ""
echo "2/3 完了！"
echo ""
echo "3/3 開発サーバーを起動します..."
echo "    http://localhost:5173 で確認できます"
echo ""
npm run dev
`

    // Generate README.md
    const readmeMd = `# PARTCOPY Export

PARTCOPYで生成されたReactプロジェクトです。画像・フォントなどのアセットは \`public/assets/\` に同梱されています。

## セットアップ（簡単）

\`\`\`bash
# 方法1: セットアップスクリプト（推奨）
chmod +x setup.sh
./setup.sh

# 方法2: 手動
npm install
npm run dev
\`\`\`

ブラウザで http://localhost:5173 を開いて確認してください。

## 構成

- \`src/components/\` に各セクションのコンポーネントがあります
- \`public/assets/\` に画像・フォント・背景画像が入っています
- \`src/index.css\` には共通のベースCSSと重複排除済みの \`@font-face\` があります

## ビルド（本番用）

\`\`\`bash
npm run build
\`\`\`

\`dist/\` フォルダに出力されます。
`

    // Generate CLAUDE.md (Claude Code用の指示書)
    const componentList = components
      .map((c, i) => `| ${i + 1} | \`src/components/${c.name}.tsx\` | ${blockFamilyJa[c.blockFamily] || c.blockFamily} |`)
      .join('\n')

    const claudeMd = `# CLAUDE.md — このプロジェクトの取扱説明書

> このファイルは Claude Code（AI）向けのガイドです。プロジェクトの構造と編集のコツがまとまっています。

---

## このプロジェクトについて

このサイトは **PARTCOPY** というツールで作られました。
プロの実在サイトから「ヒーロー」「料金プラン」「FAQ」「フッター」など、
デザインパーツを1つずつ選んで組み合わせた **React + TypeScript + Vite** のプロジェクトです。

## 最重要: reference-screenshots/ を必ず見てください

\`reference-screenshots/\` フォルダに各セクションの**元サイトのスクリーンショット**が入っています。
**これが正解の見た目**です。現在の \`src/components/\` のコードはHTMLの切り貼りなので見た目が崩れています。

あなたの仕事は：
1. **reference-screenshots/ のスクショを見て、その通りの見た目を再現する**
2. 既存のHTML/CSSは参考データとして使い、**Tailwind CSS + React で書き直す**
3. テキスト・画像パスは既存コードから引き継ぐ
4. \`design-tokens.css\` のカラー変数を使ってブランドを統一する
5. レスポンシブ対応する（Tailwindのブレークポイントを使用）

元サイトの画像（ロゴ・写真等）は \`public/assets/\` に同梱されているのでそのまま使えます。

---

## クイックスタート

\`\`\`bash
# 1. 依存パッケージをインストール
npm install

# 2. 開発サーバーを起動
npm run dev
\`\`\`

ブラウザで **http://localhost:5173** を開くとサイトが表示されます。
ファイルを保存するたびに自動でブラウザに反映されます（ホットリロード）。

本番用にビルドしたいときは：
\`\`\`bash
npm run build
\`\`\`
\`dist/\` フォルダに出力されます。Vercel・Netlify 等にそのままデプロイできます。

---

## 技術スタック

| 項目 | 内容 |
|------|------|
| フレームワーク | React 18 + TypeScript |
| ビルドツール | Vite 6 |
| アセット | \`public/assets/\` にローカル同梱済み |
| CSS | 各コンポーネント内にスコープ付きCSS（\`.pc-sec-*\`） |

---

## プロジェクト構造

\`\`\`
├── src/
│   ├── App.tsx              ← ルーティング定義（React Router）
│   ├── Layout.tsx           ← サイドバー付きレイアウト
│   ├── index.tsx            ← エントリーポイント
│   ├── index.css            ← ベースCSS + フォント定義
│   ├── pages/
│   │   └── Home.tsx         ← 全セクション一覧ページ
│   └── components/          ← 各セクションのコンポーネント
│       └── (下の一覧を参照)
├── public/
│   └── assets/              ← 画像・フォント・背景画像
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
\`\`\`

---

## コンポーネント一覧（このサイトのセクション）

このサイトは以下のセクションで構成されています。上から順にページに表示されます。

| 順番 | ファイル | セクションの種類 |
|------|----------|------------------|
${componentList}

各コンポーネントは \`src/App.tsx\` で import されて順番に並んでいます。

---

## よくある編集作業

以下は Claude Code でそのまま使えるコマンド例です。コピーしてお使いください。

### テキストの差し替え

自社の情報に書き換えたいときに使います。

\`\`\`
src/components/ 内の全コンポーネントで、ダミーテキストを以下の自社情報に差し替えてください：
- 会社名: ○○株式会社
- サービス名: ○○
- キャッチコピー: ○○
- 電話番号: 03-XXXX-XXXX
- メール: info@example.com
- 住所: 東京都○○区○○
デザインやレイアウトは一切変更しないでください。
\`\`\`

### 画像の差し替え

\`\`\`
public/assets/ 内の画像ファイル一覧を見せてください。
その後、指定するファイルを新しい画像に差し替えます。
\`\`\`

画像を差し替えるときは、同じファイル名で \`public/assets/\` に配置すればOKです。
サイズやアスペクト比はできるだけ元の画像に合わせると、レイアウトが崩れません。

### カラー（ブランドカラー）の変更

\`\`\`
サイト全体のメインカラーを #FF6B35 に統一してください。
各コンポーネントのCSS内で使われている主要な色（ボタン、見出し、アクセントなど）を
このカラーに変更してください。背景色や文字色のコントラストが十分か確認してください。
\`\`\`

### フォントの変更

\`\`\`
サイト全体のフォントを Noto Sans JP に変更してください。
src/index.css の @font-face や font-family を修正し、
各コンポーネント内の font-family も合わせて統一してください。
\`\`\`

### セクションの順序変更

\`\`\`
src/App.tsx でセクションの並び順を変更してください。
HeroSection を一番上、FooterSection を一番下にして、
間のセクション順を以下の通りにしてください：
1. Hero
2. Feature
3. Pricing
4. FAQ
5. Contact
6. Footer
\`\`\`

### セクションの削除

\`\`\`
○○Section を削除してください。
src/App.tsx から import と JSX の両方を削除してください。
src/components/○○Section.tsx ファイルも削除してOKです。
\`\`\`

### レスポンシブ対応

\`\`\`
このサイトをスマートフォンでも見やすくしてください。
各コンポーネントのCSSにメディアクエリ (@media) を追加して、
768px以下の画面幅で以下を対応してください：
- 横並びレイアウトを縦並びに
- フォントサイズの調整
- パディング・マージンの縮小
- 画像サイズの調整
既存のデザインはデスクトップ版としてそのまま残してください。
\`\`\`

### ビルド・デプロイ

\`\`\`
npm run build を実行して本番用ビルドを作成してください。
\`\`\`

${brandGuide}

---

## 注意事項（変更してはいけないもの）

編集するときに以下の点に注意してください。これらを変更するとデザインが壊れます。

1. **CSSクラス名 \`.pc-sec-*\` を変更しない**
   各セクションのCSSは \`.pc-sec-*\` というクラスでスコープされています。
   このクラス名を変更すると、スタイルが全く効かなくなります。

2. **コンポーネントの描画方式について**
   全コンポーネントはJSX形式で記述されています。Reactの作法に従って編集してください。

3. **コンポーネントの基本構造を保つ**
   \`export default function ○○Section()\` の形を維持してください。
   名前を変更する場合は \`src/App.tsx\` の import も忘れず合わせてください。

4. **\`public/assets/\` のパス構造を保つ**
   画像URLはすべてローカルファイルに変換済みです。
   ファイル名やフォルダ構造を変更する場合は、コンポーネント内のパスも合わせて更新してください。

5. **\`src/index.css\` のベーススタイル**
   リセットCSSやフォント定義が含まれています。むやみに削除しないでください。

---

## 困ったときは

- レイアウトが崩れた → \`git diff\` で変更を確認し、CSSクラス名が変わっていないか確認
- 画像が表示されない → \`public/assets/\` にファイルが存在するかパスが正しいか確認
- ビルドエラー → \`npm run dev\` のターミナル出力でエラーメッセージを確認
- セクションが表示されない → \`src/App.tsx\` の import と JSX を確認

がんばってください！素敵なサイトになることを応援しています。
`

    // Build ZIP
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', 'attachment; filename="partcopy-export.zip"')

    const archive = archiver('zip', { zlib: { level: 9 } })

    archive.on('error', (archiveErr: Error) => {
      logger.error('Archiver error mid-stream', { error: archiveErr.message })
      if (!res.headersSent) {
        res.status(500).json({ error: archiveErr.message })
      } else {
        res.end()
      }
    })

    archive.pipe(res)

    archive.append(claudeMd, { name: 'CLAUDE.md' })
    archive.append(indexHtml, { name: 'index.html' })
    archive.append(pkgJson, { name: 'package.json' })
    archive.append(tsconfigJson, { name: 'tsconfig.json' })
    archive.append(viteConfig, { name: 'vite.config.ts' })
    archive.append(setupSh, { name: 'setup.sh' })
    archive.append(readmeMd, { name: 'README.md' })
    archive.append(appTsx, { name: 'src/App.tsx' })
    archive.append(indexTsx, { name: 'src/index.tsx' })
    archive.append(layoutTsx, { name: 'src/Layout.tsx' })
    archive.append(homeTsx, { name: 'src/pages/Home.tsx' })
    archive.append(indexCss, { name: 'src/index.css' })
    archive.append(designTokensCss, { name: 'src/design-tokens.css' })

    for (const comp of components) {
      archive.append(comp.tsx, { name: `src/components/${comp.name}.tsx` })
      if (comp.cssFile) {
        archive.append(comp.cssFile, { name: `src/components/${comp.name}.css` })
      }
    }

    for (const asset of exportAssets) {
      archive.append(asset.buffer, { name: `public${asset.exportPath}`.replace(/^\//, '') })
    }

    // Add section screenshots as reference for Claude Code
    for (const screenshot of sectionScreenshots) {
      archive.append(screenshot.buffer, { name: `reference-screenshots/${screenshot.name}.png` })
    }

    // Add placeholder for missing assets or when images are excluded
    if (failedAssetUrls.size > 0 || !includeImages) {
      const placeholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#f0f0f0"/><text x="200" y="150" text-anchor="middle" fill="#999" font-family="sans-serif" font-size="14">Image not available</text></svg>`
      archive.append(placeholderSvg, { name: 'public/assets/placeholder.svg' })
    }

    await archive.finalize()
  } catch (err: any) {
    logger.error('ZIP export failed', { error: err.message })
    if (!res.headersSent) {
      res.status(500).json({ error: safeErrorMessage(err) })
    }
  }
})

// ============================================================
// Auto-Crawl Queue Management
// ============================================================
import {
  getQueueStatus,
  appendToQueue,
  clearQueue,
  isAutoCrawlActive
} from './auto-crawler.js'

app.get('/api/crawl-queue', async (_req, res) => {
  try {
    const status = await getQueueStatus()
    res.json(status)
  } catch (err: any) {
    logger.error('Crawl queue status failed', { error: err.message })
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

app.post('/api/crawl-queue', async (req, res) => {
  const { urls } = req.body
  if (!Array.isArray(urls) || !urls.every((u: unknown) => typeof u === 'string')) {
    res.status(400).json({ error: 'urls must be an array of strings' })
    return
  }

  try {
    const added = await appendToQueue(urls)

    // workerプロセスのauto-crawlerが30秒ごとにキューをチェック
    const status = await getQueueStatus()
    res.json({ added, ...status })
  } catch (err: any) {
    logger.error('Crawl queue append failed', { error: err.message })
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// キーワード検索 → 自動クロール
// ============================================================
app.post('/api/keyword-search', async (req, res) => {
  const { keyword } = req.body
  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    res.status(400).json({ error: 'キーワードを入力してください' })
    return
  }

  try {
    const { searchAndQueue } = await import('./keyword-crawler.js')
    const result = await searchAndQueue(keyword.trim())
    res.json(result)
  } catch (err: any) {
    logger.error('Keyword search failed', { keyword, error: err.message })
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

app.post('/api/crawl-queue/start', async (_req, res) => {
  try {
    // workerプロセスのauto-crawlerが30秒以内にキューを拾う
    const status = await getQueueStatus()
    res.json({ started: true, ...status })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

app.delete('/api/crawl-queue', async (_req, res) => {
  try {
    await clearQueue()
    res.json({ cleared: true })
  } catch (err: any) {
    logger.error('Crawl queue clear failed', { error: err.message })
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Projects (Canvas configurations)
// ============================================================
app.get('/api/projects', async (_req, res) => {
  try {
    if (HAS_SUPABASE) {
      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw new Error(error.message)
      res.json({ projects: data || [] })
    } else {
      const projects = await listProjects()
      res.json({ projects })
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/projects', async (req, res) => {
  const { name } = req.body
  if (!name) { res.status(400).json({ error: 'name required' }); return }
  try {
    if (HAS_SUPABASE) {
      const { data, error } = await supabaseAdmin
        .from('projects')
        .insert({ name, canvas_json: [] })
        .select()
        .single()
      if (error) throw new Error(error.message)
      res.json({ project: data })
    } else {
      const project = await createLocalProject(name)
      res.json({ project })
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/projects/:id', async (req, res) => {
  const { canvas_json, name } = req.body
  try {
    if (HAS_SUPABASE) {
      const patch: any = {}
      if (canvas_json !== undefined) patch.canvas_json = canvas_json
      if (name !== undefined) patch.name = name
      const { data, error } = await supabaseAdmin
        .from('projects')
        .update(patch)
        .eq('id', req.params.id)
        .select()
        .single()
      if (error) throw new Error(error.message)
      res.json({ project: data })
    } else {
      const project = await updateLocalProject(req.params.id, { name, canvas_json })
      res.json({ project })
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/projects/:id', async (req, res) => {
  try {
    if (HAS_SUPABASE) {
      await supabaseAdmin.from('projects').delete().eq('id', req.params.id)
    } else {
      await deleteLocalProject(req.params.id)
    }
    res.json({ deleted: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

const PORT = Number(process.env.PARTCOPY_API_PORT || 3001)
const server = app.listen(PORT, () => {
  logger.info('API server started', { port: PORT, supabase: HAS_SUPABASE })
})

let shuttingDown = false
const shutdownHandler = () => {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('Server shutting down')
  server.close(() => {
    process.exit(0)
  })
  // Force exit after 2s if close hangs
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGTERM', shutdownHandler)
process.on('SIGINT', shutdownHandler)
