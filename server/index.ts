/**
 * API Server - Lightweight. No Puppeteer.
 * Creates jobs, serves results from Supabase.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
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
  deleteProject as deleteLocalProject,
  updateSourceSection
} from './local-store.js'
import { HAS_SUPABASE, supabaseAdmin } from './supabase.js'
import { STORAGE_BUCKETS } from './storage-config.js'
import { logger } from './logger.js'
import { convertHtmlToTsx } from './claude-converter.js'
import {
  buildComponentName,
} from './export-instructions.js'
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
import { extractColorsFromCss, extractFontsFromCss, generateDesignTokensCss, generateBrandGuide, generateBrandOverrideCss, analyzeCssSophistication } from './design-tokens.js'
import {
  streamScreenshotZipExport as streamScreenshotZipExportService,
  type ExportSectionArtifact,
  type GetArtifactFn,
} from './export-screenshot-zip.js'
import { streamTsxZipExport, type TsxZipExportInput } from './export-tsx-zip.js'
import { canonicalizeSectionFull, extractStyleFingerprint } from './canonicalizer.js'
import type { CanonicalSection } from './canonical-types.js'

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

// ExportSectionArtifact is now imported from ./export-screenshot-zip.js

async function getExportSectionArtifact(
  sectionId: string,
  index: number,
  usedComponentNames: Set<string>
): Promise<ExportSectionArtifact | null> {
  const prepared = await prepareSectionRender(sectionId)
  if (!prepared) return null

  let blockFamily = prepared.blockFamily || 'section'
  let thumbnailPath = ''
  let textSummary = ''
  let sourceUrl = ''
  let sourceTitle = ''
  let domain = 'unknown'

  if (HAS_SUPABASE) {
    const { data: section } = await supabaseAdmin
      .from('source_sections')
      .select('id, block_family, thumbnail_storage_path, text_summary, source_pages(url, title), source_sites(normalized_domain)')
      .eq('id', sectionId)
      .single()

    blockFamily = section?.block_family || blockFamily
    thumbnailPath = section?.thumbnail_storage_path || ''
    textSummary = section?.text_summary || ''
    sourceUrl = section?.source_pages?.url || ''
    sourceTitle = section?.source_pages?.title || ''
    domain = section?.source_sites?.normalized_domain || ''
  } else {
    const section = await getSection(sectionId)
    const page = section ? await getPageById(section.page_id) : null
    blockFamily = section?.block_family || blockFamily
    thumbnailPath = section?.thumbnail_storage_path || ''
    textSummary = section?.text_summary || ''
    sourceUrl = page?.url || ''
    sourceTitle = page?.title || ''
  }

  if (!domain && sourceUrl) {
    try {
      domain = new URL(sourceUrl).hostname.replace(/^www\./, '')
    } catch {
      domain = 'unknown'
    }
  }

  const componentName = buildComponentName(blockFamily, index, usedComponentNames)
  const screenshotBuffer = thumbnailPath
    ? (
      await readBucketFile(STORAGE_BUCKETS.SECTION_THUMBNAILS, thumbnailPath)
      || await readBucketFile(STORAGE_BUCKETS.RAW_HTML, thumbnailPath)
    )?.buffer
    : undefined
  const screenshotFile = `${String(index).padStart(2, '0')}-${blockFamily.replace(/[^a-z0-9_-]+/gi, '-') || 'section'}.${screenshotBuffer ? 'png' : 'svg'}`

  return {
    sectionId,
    blockFamily,
    componentName,
    domain: domain || 'unknown',
    sourceUrl: sourceUrl || undefined,
    sourceTitle: sourceTitle || undefined,
    textSummary: textSummary || undefined,
    screenshotFile,
    screenshotBuffer,
    html: prepared.html,
    css: prepared.css
  }
}

/**
 * Screenshot ZIP export - delegates to export-screenshot-zip.ts service.
 * getExportSectionArtifact is passed as a callback to keep DB access in index.ts.
 */
async function streamScreenshotZipExport(
  args: {
    sectionIds: string[]
    projectName?: string
    companyName?: string
    serviceDescription?: string
  },
  res: express.Response
) {
  await streamScreenshotZipExportService(args, res, getExportSectionArtifact)
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

  const searchTerm = normalizeSearchValue(filters.q)
  // Only over-fetch when text search is active (can't be done server-side)
  const fetchLimit = searchTerm ? Math.min(filters.limit * 3, 5000) : filters.limit

  // Build a fresh query for each page (Supabase query builder is mutable)
  function buildQuery() {
    let q = supabaseAdmin
      .from('source_sections')
      .select('*, source_sites!inner(normalized_domain, genre, tags, industry), source_pages(url, title)')

    if (filters.genre) q = q.eq('source_sites.genre', filters.genre)
    if (filters.family) q = q.eq('block_family', filters.family)
    if (filters.industry) q = q.eq('source_sites.industry', filters.industry)

    if (filters.hasCta) q = q.contains('features_jsonb', { hasCTA: true })
    if (filters.hasForm) q = q.contains('features_jsonb', { hasForm: true })
    if (filters.hasImages) q = q.contains('features_jsonb', { hasImages: true })

    switch (filters.sort) {
      case 'confidence':
        q = q.order('classifier_confidence', { ascending: false })
        break
      case 'family':
        q = q.order('block_family', { ascending: true })
        break
      case 'oldest':
        q = q.order('created_at', { ascending: true })
        break
      case 'newest':
      default:
        q = q.order('created_at', { ascending: false })
        break
    }
    return q
  }

  // Supabase returns max 1000 rows per request — paginate to fetch all
  const PAGE_SIZE = 1000
  let results: any[] = []
  let from = 0
  while (from < fetchLimit) {
    const batchSize = Math.min(PAGE_SIZE, fetchLimit - from)
    const { data, error } = await buildQuery().range(from, from + batchSize - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    results = results.concat(data)
    if (data.length < batchSize) break
    from += batchSize
  }

  // Client-side text search (only when search term is present)
  if (searchTerm) {
    results = results.filter((section: any) => {
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
  }

  // For 'source' sort, we need client-side sorting since it's on a joined field
  if (filters.sort === 'source') {
    results.sort((a: any, b: any) =>
      String(a.source_sites?.normalized_domain || '').localeCompare(String(b.source_sites?.normalized_domain || ''))
    )
  }

  return results.slice(0, filters.limit)
}

async function getGenreResults() {
  if (!HAS_SUPABASE) {
    return getGenreSummary()
  }

  // Get unique genres from source_sites, then count sections per site's genre
  const { data: sites, error } = await supabaseAdmin
    .from('source_sites')
    .select('id, genre')

  if (error) throw new Error(error.message)

  // Count sections per site using exact counts
  const genreSitesMap: Record<string, string[]> = {}
  for (const site of sites || []) {
    const genre = site.genre || 'untagged'
    if (!genreSitesMap[genre]) genreSitesMap[genre] = []
    genreSitesMap[genre].push(site.id)
  }

  const results = await Promise.all(
    Object.entries(genreSitesMap).map(async ([genre, siteIds]) => {
      const { count, error: cErr } = await supabaseAdmin
        .from('source_sections')
        .select('id', { count: 'exact', head: true })
        .in('site_id', siteIds)
      return { genre, count: (!cErr && count != null) ? count : 0 }
    })
  )

  return results.filter(r => r.count > 0).sort((a, b) => b.count - a.count)
}

async function getFamilyResults() {
  if (!HAS_SUPABASE) {
    return getFamilySummary()
  }

  const { data: families, error } = await supabaseAdmin
    .from('block_families')
    .select('key, label, label_ja, sort_order')
    .order('sort_order')

  if (error) {
    throw new Error(error.message)
  }

  // Count per family using individual count queries (avoids 1000-row default limit)
  const counts: Record<string, number> = {}
  await Promise.all((families || []).map(async (f: any) => {
    const { count, error: cErr } = await supabaseAdmin
      .from('source_sections')
      .select('id', { count: 'exact', head: true })
      .eq('block_family', f.key)
    if (!cErr && count != null) counts[f.key] = count
  }))

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
// ============================================================
// Design quality scoring (local, no API)
// ============================================================
function computeDesignQuality(section: any): { score: number; flags: string[] } {
  const f = section.features_jsonb || {}
  const text = section.text_summary || ''
  const family = section.block_family || ''
  const flags: string[] = []

  // --- Garbage detection (instant disqualifiers → score 0) ---
  if (/\{\s*(position|display|width|height|margin|padding)\s*:/.test(text)) {
    flags.push('css_leak')
  }
  if ((f.linkCount || 0) >= 40 && (f.headingCount || 0) <= 1 && family !== 'footer') {
    flags.push('nav_dump')
  }
  if ((f.textLength || text.length) < 20 && (f.imageCount || 0) === 0) {
    flags.push('empty')
  }
  if ((f.textLength || text.length) > 5000 && (f.headingCount || 0) >= 10) {
    flags.push('page_dump')
  }
  if ((f.imageCount || 0) === 1 && (f.textLength || text.length) < 30 && (f.buttonCount || 0) === 0) {
    flags.push('image_only')
  }
  // Any garbage flag → score 0, don't bother computing further
  if (flags.length > 0) {
    return { score: 0, flags }
  }

  // --- Content quality (max 30 points) ---
  let contentScore = 0
  if (f.hasImages || (f.imageCount || 0) > 0) contentScore += 6
  if (f.hasCTA || (f.buttonCount || 0) > 0) contentScore += 5
  if ((f.headingCount || 0) >= 1 && (f.headingCount || 0) <= 5) contentScore += 5
  if ((f.cardCount || 0) >= 2) contentScore += 5
  if (f.hasForm) contentScore += 3
  if (f.repeatedChildPattern) contentScore += 3
  const tl = f.textLength || text.length
  if (tl >= 50 && tl <= 2000) contentScore += 3
  contentScore = Math.min(contentScore, 30)

  // --- CSS sophistication (max 50 points) ---
  // Pre-computed by /api/library/reanalyze and stored in features_jsonb
  const cssSoph = f.cssSophistication || 0
  const cssScore = Math.round(cssSoph * 0.5) // 0-100 → 0-50

  // --- Classifier confidence (max 20 points) ---
  const conf = section.classifier_confidence || 0
  const confScore = Math.round(conf * 20)

  const score = Math.max(0, Math.min(100, contentScore + cssScore + confScore))
  return { score, flags }
}

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
    hasImages,
    hideJunk
  } = req.query

  const limit = Math.min(Math.max(Number(lim) || 60, 1), 5000)
  const shouldHideJunk = parseBooleanQuery(hideJunk)
  try {
    // When sorting by quality or hiding junk, fetch more to filter/sort client-side
    const fetchLimit = (sort === 'quality' || shouldHideJunk) ? Math.min(limit * 3, 5000) : limit
    const results = await getLibraryResults({
      genre: typeof genre === 'string' ? genre : undefined,
      family: typeof family === 'string' ? family : undefined,
      industry: typeof industry === 'string' ? industry : undefined,
      limit: fetchLimit,
      q: typeof q === 'string' ? q : undefined,
      sort: sort === 'quality' ? 'newest' : (typeof sort === 'string' ? sort : 'newest'),
      hasCta: parseBooleanQuery(hasCta),
      hasForm: parseBooleanQuery(hasForm),
      hasImages: parseBooleanQuery(hasImages)
    })

    // Compute quality scores
    let scored = results.map((section: any) => {
      const { score, flags } = computeDesignQuality(section)
      return { ...section, designScore: score, designFlags: flags }
    })

    // Filter junk
    if (shouldHideJunk) {
      scored = scored.filter((s: any) => s.designFlags.length === 0)
    }

    // Sort by quality
    if (sort === 'quality') {
      scored.sort((a: any, b: any) => b.designScore - a.designScore)
    }

    res.json({
      sections: scored.slice(0, limit).map((section: any) => ({
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
// Library: Total section count
// ============================================================
app.get('/api/library/count', async (_req, res) => {
  try {
    if (HAS_SUPABASE) {
      const { count, error } = await supabaseAdmin
        .from('source_sections')
        .select('id', { count: 'exact', head: true })
      if (error) throw new Error(error.message)
      res.json({ count: count || 0 })
    } else {
      const sections = await listLibrarySections({ limit: 100000, sort: 'newest' })
      res.json({ count: sections.length })
    }
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Reanalyze: compute CSS sophistication for all sections
// ============================================================
let reanalyzeRunning = false
app.post('/api/library/reanalyze', async (_req, res) => {
  if (reanalyzeRunning) {
    res.json({ status: 'already_running' })
    return
  }
  reanalyzeRunning = true
  res.json({ status: 'started' })

  // Run in background
  ;(async () => {
    try {
      // Get all sections
      const allSections = HAS_SUPABASE
        ? (await supabaseAdmin.from('source_sections').select('id, page_id, features_jsonb, block_family, text_summary, classifier_confidence').limit(10000)).data || []
        : await listLibrarySections({ limit: 100000, sort: 'newest' })

      // Group by page_id to load CSS once per page
      const byPage = new Map<string, typeof allSections>()
      for (const s of allSections) {
        const pageId = s.page_id || 'unknown'
        if (!byPage.has(pageId)) byPage.set(pageId, [])
        byPage.get(pageId)!.push(s)
      }

      let analyzed = 0
      let deleted = 0
      const QUALITY_THRESHOLD = 10 // Sections below this get auto-deleted (low to accommodate SPA sites with dynamic CSS)

      for (const [pageId, sections] of byPage) {
        // Load CSS for this page once
        let cssBundle = ''
        try {
          if (HAS_SUPABASE) {
            const { data: page } = await supabaseAdmin.from('source_pages').select('css_bundle_path').eq('id', pageId).single()
            if (page?.css_bundle_path) cssBundle = await loadSectionCssBundle(page.css_bundle_path)
          } else {
            const page = await getPageById(pageId)
            if (page?.css_bundle_path) cssBundle = await loadSectionCssBundle(page.css_bundle_path)
          }
        } catch {}

        const { score: cssSoph } = analyzeCssSophistication(cssBundle)

        for (const section of sections) {
          const features = section.features_jsonb || {}
          features.cssSophistication = cssSoph
          const updatedFeatures = { ...features, cssSophistication: cssSoph }

          // Compute new quality score to check threshold
          const quality = computeDesignQuality({ ...section, features_jsonb: updatedFeatures })

          if (quality.score < QUALITY_THRESHOLD) {
            // Delete low quality section
            try {
              if (HAS_SUPABASE) {
                await supabaseAdmin.from('source_sections').delete().eq('id', section.id)
              } else {
                await deleteLocalSection(section.id)
              }
              deleted++
            } catch {}
          } else {
            // Update features_jsonb with CSS sophistication
            try {
              if (HAS_SUPABASE) {
                await supabaseAdmin.from('source_sections').update({ features_jsonb: updatedFeatures }).eq('id', section.id)
              } else {
                await updateSourceSection(section.id, { features_jsonb: updatedFeatures } as any)
              }
            } catch {}
          }
          analyzed++
        }

        if (analyzed % 100 === 0) {
          logger.info('Reanalyze progress', { analyzed, deleted, total: allSections.length })
        }
      }

      logger.info('Reanalyze complete', { analyzed, deleted, total: allSections.length })
    } catch (err: any) {
      logger.error('Reanalyze failed', { error: err.message })
    } finally {
      reanalyzeRunning = false
    }
  })()
})

app.get('/api/library/reanalyze/status', (_req, res) => {
  res.json({ running: reanalyzeRunning })
})

// ============================================================
// Sites count
// ============================================================
app.get('/api/sites/count', async (_req, res) => {
  try {
    if (HAS_SUPABASE) {
      const { count, error } = await supabaseAdmin
        .from('source_sites')
        .select('id', { count: 'exact', head: true })
      if (error) throw new Error(error.message)
      res.json({ count: count || 0 })
    } else {
      res.json({ count: 0 })
    }
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
    // Clean orphaned references from all projects' canvas_json
    await cleanCanvasRefsForDeletedSection(req.params.id)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Dedup: Remove duplicate sections (same text_summary prefix per site)
// ============================================================
app.post('/api/dedup-sections', async (req, res) => {
  try {
    if (!HAS_SUPABASE) {
      res.status(501).json({ error: 'Dedup is only supported with Supabase' })
      return
    }

    // Fetch all sections grouped by site_id, ordered by order_index
    const { data: allSections, error } = await supabaseAdmin
      .from('source_sections')
      .select('id, site_id, text_summary, order_index')
      .order('order_index', { ascending: true })

    if (error) throw new Error(error.message)

    // Group by site_id, find duplicates by first 200 chars of text_summary
    const toDelete: string[] = []
    const bySite = new Map<string, typeof allSections>()

    for (const section of allSections || []) {
      const siteId = section.site_id
      if (!bySite.has(siteId)) bySite.set(siteId, [])
      bySite.get(siteId)!.push(section)
    }

    for (const [, sections] of bySite) {
      const seen = new Set<string>()
      for (const section of sections) {
        const key = (section.text_summary || '').slice(0, 200).trim()
        if (key.length === 0) continue
        if (seen.has(key)) {
          toDelete.push(section.id)
        } else {
          seen.add(key)
        }
      }
    }

    // Delete duplicates in batches
    const BATCH = 100
    for (let i = 0; i < toDelete.length; i += BATCH) {
      const batch = toDelete.slice(i, i + BATCH)
      const { error: delError } = await supabaseAdmin
        .from('source_sections')
        .delete()
        .in('id', batch)
      if (delError) throw new Error(delError.message)
    }

    res.json({ deleted: toDelete.length })
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
// Helper: Remove a sectionId from all projects' canvas_json
// ============================================================
async function cleanCanvasRefsForDeletedSection(deletedSectionId: string) {
  try {
    if (HAS_SUPABASE) {
      const { data: projects } = await supabaseAdmin
        .from('projects')
        .select('id, canvas_json')
      if (projects) {
        for (const proj of projects) {
          if (!Array.isArray(proj.canvas_json)) continue
          const cleaned = proj.canvas_json.filter(
            (block: any) => block.sectionId !== deletedSectionId
          )
          if (cleaned.length !== proj.canvas_json.length) {
            await supabaseAdmin
              .from('projects')
              .update({ canvas_json: cleaned })
              .eq('id', proj.id)
          }
        }
      }
    } else {
      const projects = await listProjects()
      for (const proj of projects) {
        if (!Array.isArray(proj.canvas_json)) continue
        const cleaned = proj.canvas_json.filter(
          (block: any) => block.sectionId !== deletedSectionId
        )
        if (cleaned.length !== proj.canvas_json.length) {
          await updateLocalProject(proj.id, { canvas_json: cleaned })
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to clean canvas refs for deleted section', { sectionId: deletedSectionId, error: (err as Error).message })
  }
}

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
    // Clean orphaned references from all projects' canvas_json
    await cleanCanvasRefsForDeletedSection(sectionId)
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
  logger.info('TSX conversion requested', { sectionId })
  const startTime = Date.now()
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

    logger.info('Starting Claude CLI conversion', { sectionId, blockFamily, htmlLength: html.length })
    const tsx = await convertHtmlToTsx(scopedHtml, blockFamily)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    logger.info('TSX conversion completed', { sectionId, blockFamily, tsxLength: tsx.length, elapsedSec: elapsed })

    // Save converted TSX to storage so ZIP export doesn't re-convert
    if (HAS_SUPABASE) {
      const tsxPath = `${sectionId}/component.tsx`
      const tsxBuffer = Buffer.from(tsx, 'utf-8')
      await supabaseAdmin.storage.from(STORAGE_BUCKETS.SANITIZED_HTML).upload(tsxPath, tsxBuffer, { contentType: 'text/plain', upsert: true })
      await supabaseAdmin.from('source_sections').update({ tsx_code_storage_path: tsxPath }).eq('id', sectionId)
      logger.info('Saved converted TSX to storage', { sectionId, path: tsxPath })
    }

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
// ZIP Export - screenshot + instruction based rebuild kit
// ============================================================
app.post('/api/export/zip', async (req, res) => {
  const { sectionIds, projectName, companyName, serviceDescription } = req.body as {
    sectionIds: string[]
    projectName?: string
    companyName?: string
    serviceDescription?: string
  }

  if (!sectionIds || !Array.isArray(sectionIds) || sectionIds.length === 0) {
    res.status(400).json({ error: 'sectionIds array required' })
    return
  }

  try {
    await streamScreenshotZipExport({ sectionIds, projectName, companyName, serviceDescription }, res)
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
// ============================================================
// Screenshot-based Export (new pipeline)
// ============================================================
app.post('/api/export/screenshot-zip', async (req, res) => {
  const { sectionIds, projectName, companyName, serviceDescription, serviceName } = req.body as {
    sectionIds: string[]
    projectName?: string
    serviceName?: string
    companyName?: string
    serviceDescription?: string
  }

  if (!sectionIds || !Array.isArray(sectionIds) || sectionIds.length === 0) {
    res.status(400).json({ error: 'sectionIds array required' })
    return
  }

  try {
    await streamScreenshotZipExport({
      sectionIds,
      projectName: projectName || serviceName,
      companyName,
      serviceDescription
    }, res)
  } catch (err: any) {
    logger.error('Screenshot ZIP export failed', { error: err.message })
    if (!res.headersSent) {
      res.status(500).json({ error: safeErrorMessage(err) })
    }
  }
})

// ============================================================
// TSX ZIP Export (canonical + theme based)
// ============================================================
app.post('/api/export/tsx-zip', async (req, res) => {
  const { sectionIds, projectName, companyName, serviceDescription } = req.body as {
    sectionIds: string[]
    projectName?: string
    companyName?: string
    serviceDescription?: string
  }

  if (!sectionIds || !Array.isArray(sectionIds) || sectionIds.length === 0) {
    res.status(400).json({ error: 'sectionIds array required' })
    return
  }

  try {
    const canonicalSections: CanonicalSection[] = []
    const cssTexts: string[] = []
    const screenshotBuffers = new Map<string, Buffer>()

    for (const sectionId of sectionIds) {
      const prepared = await prepareSectionRender(sectionId)
      if (!prepared) continue

      let blockFamily = prepared.blockFamily || 'section'
      let thumbnailPath = ''
      let sourceUrl = ''
      let sourceDomain = 'unknown'
      let textSummary = ''

      if (HAS_SUPABASE) {
        const { data: section } = await supabaseAdmin
          .from('source_sections')
          .select('id, block_family, block_variant, thumbnail_storage_path, text_summary, features_jsonb, source_pages(url, title), source_sites(normalized_domain)')
          .eq('id', sectionId)
          .single()
        blockFamily = section?.block_family || blockFamily
        thumbnailPath = section?.thumbnail_storage_path || ''
        sourceUrl = section?.source_pages?.url || ''
        sourceDomain = section?.source_sites?.normalized_domain || ''
        textSummary = section?.text_summary || ''
      } else {
        const section = await getSection(sectionId)
        const page = section ? await getPageById(section.page_id) : null
        blockFamily = section?.block_family || blockFamily
        thumbnailPath = section?.thumbnail_storage_path || ''
        sourceUrl = page?.url || ''
        textSummary = section?.text_summary || ''
        if (sourceUrl) {
          try { sourceDomain = new URL(sourceUrl).hostname.replace(/^www\./, '') } catch {}
        }
      }

      // Build a minimal DetectedSection for canonicalization
      const minimalSection = {
        tagName: 'section',
        html: prepared.html,
        textContent: textSummary || '',
        classTokens: [] as string[],
        computedStyles: { textAlign: 'left', backgroundColor: 'transparent', fontSize: '16px', padding: '0' },
        features: {
          headingTexts: [] as string[],
          imageCount: 0,
          buttonCount: 0,
          linkCount: 0,
          formCount: 0,
          listItemCount: 0,
          cardCount: 0,
          childCount: 0,
          textLength: textSummary?.length || 0,
          hasSvg: false,
          repeatedChildPattern: false,
        },
      } as any

      const canonical = canonicalizeSectionFull(minimalSection, blockFamily, {
        sectionId,
        css: prepared.css,
        screenshotPath: thumbnailPath,
        sourceUrl,
        sourceDomain,
      })

      if (canonical) {
        canonicalSections.push(canonical)
        cssTexts.push(prepared.css)

        // Load screenshot
        if (thumbnailPath) {
          const file = await readBucketFile(STORAGE_BUCKETS.SECTION_THUMBNAILS, thumbnailPath)
            || await readBucketFile(STORAGE_BUCKETS.RAW_HTML, thumbnailPath)
          if (file) {
            screenshotBuffers.set(sectionId, file.buffer)
          }
        }
      }
    }

    await streamTsxZipExport({
      sections: canonicalSections,
      cssTexts,
      screenshotBuffers,
      projectName,
      companyName,
      serviceDescription,
    }, res)
  } catch (err: any) {
    logger.error('TSX ZIP export failed', { error: err.message })
    if (!res.headersSent) {
      res.status(500).json({ error: safeErrorMessage(err) })
    }
  }
})

// ============================================================
// Canonicalize section (API)
// ============================================================
app.post('/api/sections/:sectionId/canonicalize', async (req, res) => {
  const { sectionId } = req.params
  try {
    const prepared = await prepareSectionRender(sectionId)
    if (!prepared) {
      res.status(404).json({ error: 'Section not found' })
      return
    }

    let blockFamily = prepared.blockFamily || 'section'
    let sourceUrl = ''
    let sourceDomain = 'unknown'

    if (HAS_SUPABASE) {
      const { data } = await supabaseAdmin
        .from('source_sections')
        .select('block_family, source_pages(url), source_sites(normalized_domain)')
        .eq('id', sectionId)
        .single()
      blockFamily = data?.block_family || blockFamily
      sourceUrl = data?.source_pages?.url || ''
      sourceDomain = data?.source_sites?.normalized_domain || ''
    } else {
      const section = await getSection(sectionId)
      const page = section ? await getPageById(section.page_id) : null
      blockFamily = section?.block_family || blockFamily
      sourceUrl = page?.url || ''
      if (sourceUrl) {
        try { sourceDomain = new URL(sourceUrl).hostname.replace(/^www\./, '') } catch {}
      }
    }

    const minimalSection = {
      tagName: 'section',
      html: prepared.html,
      textContent: '',
      classTokens: [],
      computedStyles: { textAlign: 'left', backgroundColor: 'transparent', fontSize: '16px', padding: '0' },
      features: {
        headingTexts: [],
        imageCount: 0,
        buttonCount: 0,
        linkCount: 0,
        formCount: 0,
        listItemCount: 0,
        cardCount: 0,
        childCount: 0,
        textLength: 0,
        hasSvg: false,
        repeatedChildPattern: false,
      },
    } as any

    const canonical = canonicalizeSectionFull(minimalSection, blockFamily, {
      sectionId,
      css: prepared.css,
      sourceUrl,
      sourceDomain,
    })

    if (!canonical) {
      res.status(500).json({ error: 'Canonicalization failed' })
      return
    }

    res.json({ canonicalSection: canonical })
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

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

// ============================================================
// Project cleanup: remove orphaned sectionIds from canvas_json
// ============================================================
app.post('/api/projects/:id/cleanup', async (req, res) => {
  try {
    let project: any
    if (HAS_SUPABASE) {
      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('id, canvas_json')
        .eq('id', req.params.id)
        .single()
      if (error) throw new Error(error.message)
      project = data
    } else {
      const projects = await listProjects()
      project = projects.find((p: any) => p.id === req.params.id)
    }
    if (!project) { res.status(404).json({ error: 'Project not found' }); return }

    const canvasJson: any[] = Array.isArray(project.canvas_json) ? project.canvas_json : []
    if (canvasJson.length === 0) {
      res.json({ project, removed: 0 })
      return
    }

    // Check which sectionIds actually exist
    const sectionIds = [...new Set(canvasJson.map((b: any) => b.sectionId))]
    const existingIds = new Set<string>()

    if (HAS_SUPABASE) {
      const { data: rows } = await supabaseAdmin
        .from('source_sections')
        .select('id')
        .in('id', sectionIds)
      if (rows) rows.forEach((r: any) => existingIds.add(r.id))
    } else {
      for (const sid of sectionIds) {
        const sec = await getSection(sid)
        if (sec) existingIds.add(sid)
      }
    }

    const cleaned = canvasJson.filter((b: any) => existingIds.has(b.sectionId))
    const removedCount = canvasJson.length - cleaned.length

    if (removedCount > 0) {
      if (HAS_SUPABASE) {
        const { data, error } = await supabaseAdmin
          .from('projects')
          .update({ canvas_json: cleaned })
          .eq('id', req.params.id)
          .select()
          .single()
        if (error) throw new Error(error.message)
        res.json({ project: data, removed: removedCount })
      } else {
        const updated = await updateLocalProject(req.params.id, { canvas_json: cleaned })
        res.json({ project: updated, removed: removedCount })
      }
    } else {
      res.json({ project, removed: 0 })
    }
  } catch (err: any) {
    res.status(500).json({ error: safeErrorMessage(err) })
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

// ============================================================
// Fast Crawl (bulk high-concurrency)
// ============================================================
import { fastCrawlUrls, getFastCrawlStats } from './fast-crawler.js'

app.post('/api/fast-crawl', async (req, res) => {
  const { urls } = req.body
  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'urls must be a non-empty array' })
    return
  }

  const validUrls = urls
    .map((u: any) => typeof u === 'string' ? u.trim() : '')
    .filter((u: string) => u.length > 0 && /^https?:\/\//i.test(u))

  if (validUrls.length === 0) {
    res.status(400).json({ error: 'No valid URLs provided' })
    return
  }

  logger.info('Fast-crawl API: starting', { count: validUrls.length })

  // Run async, return immediately
  const jobId = `fast-${Date.now()}`
  res.json({
    jobId,
    message: `${validUrls.length}件のクロールを開始しました`,
    count: validUrls.length,
  })

  // Process in background
  fastCrawlUrls(validUrls)
    .then(result => {
      logger.info('Fast-crawl API: complete', { jobId, ...result })
    })
    .catch(err => {
      logger.error('Fast-crawl API: failed', { jobId, error: err.message })
    })
})

app.get('/api/fast-crawl/stats', async (_req, res) => {
  const stats = getFastCrawlStats()
  res.json(stats)
})

// ============================================================
// Claude Reclassification (local CLI)
// ============================================================
import { reclassifySections } from './claude-classifier.js'

app.post('/api/reclassify', async (req, res) => {
  const { siteId, limit } = req.body || {}
  logger.info('Reclassify: starting', { siteId, limit })

  res.json({ message: '再分類を開始しました', status: 'running' })

  // Run in background
  reclassifySections({ siteId, limit: limit || 500 })
    .then(result => {
      logger.info('Reclassify: complete', result)
    })
    .catch(err => {
      logger.error('Reclassify: failed', { error: err.message })
    })
})

app.get('/api/reclassify/status', async (_req, res) => {
  // Quick check: count sections by family
  if (!HAS_SUPABASE) {
    res.json({ families: {} })
    return
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('source_sections')
      .select('block_family')
    if (error) throw new Error(error.message)

    const counts: Record<string, number> = {}
    for (const row of (data || [])) {
      const f = row.block_family || 'unknown'
      counts[f] = (counts[f] || 0) + 1
    }
    res.json({ families: counts, total: data?.length || 0 })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// Page Clone — fetch高速版 + SPA検知でClaude自動フォールバック
// ============================================================
import { clonePageWithClaude } from './claude-cloner.js'

/** fetch版: 高速にHTML/CSS/画像/フォントを取得してインライン化 */
async function fetchClonePage(url: string) {
  const pageOrigin = new URL(url).origin
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

  // Step 1: HTML取得
  const htmlRes = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'ja,en;q=0.9' },
    redirect: 'follow'
  })
  if (!htmlRes.ok) throw new Error(`ページ取得失敗 (${htmlRes.status})`)
  let html = await htmlRes.text()

  // Step 2: CSS URL抽出（<link rel="stylesheet">, <link href="...css">, @import）
  const cssUrls: string[] = []
  let m: RegExpExecArray | null
  // <link rel="stylesheet" href="...">
  const linkRe = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi
  while ((m = linkRe.exec(html)) !== null) {
    try { cssUrls.push(new URL(m[1], url).href) } catch {}
  }
  // <link href="...css">（rel=stylesheetが前にないパターン）
  const cssHrefRe = /<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi
  while ((m = cssHrefRe.exec(html)) !== null) {
    try {
      const resolved = new URL(m[1], url).href
      if (!cssUrls.includes(resolved)) cssUrls.push(resolved)
    } catch {}
  }

  const cssContents: string[] = []
  const urlMap = new Map<string, string>()

  // Step 2b: CSSダウンロード + CSS内アセット取得
  for (const cssUrl of cssUrls) {
    try {
      const cssRes = await fetch(cssUrl, { headers: { 'User-Agent': UA, 'Referer': url } })
      if (!cssRes.ok) continue
      let cssText = await cssRes.text()

      // @import追跡
      const importRe = /@import\s+url\(\s*['"]?([^'")]+?)['"]?\s*\)/g
      while ((m = importRe.exec(cssText)) !== null) {
        try {
          const importUrl = new URL(m[1], cssUrl).href
          if (!cssUrls.includes(importUrl)) {
            const importRes = await fetch(importUrl, { headers: { 'User-Agent': UA } })
            if (importRes.ok) cssContents.push(await importRes.text())
          }
        } catch {}
      }

      // CSS内url()アセット（画像・フォント）
      const urlRe = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/g
      const cssAssetUrls: string[] = []
      while ((m = urlRe.exec(cssText)) !== null) {
        const ref = m[1].trim()
        if (ref.startsWith('data:') || ref.startsWith('#')) continue
        try { cssAssetUrls.push(new URL(ref, cssUrl).href) } catch {}
      }

      // CSS内アセット並列ダウンロード→data URI化
      const ASSET_BATCH = 15
      for (let i = 0; i < cssAssetUrls.length; i += ASSET_BATCH) {
        await Promise.allSettled(cssAssetUrls.slice(i, i + ASSET_BATCH).map(async (assetUrl) => {
          if (urlMap.has(assetUrl)) return
          try {
            const r = await fetch(assetUrl, { headers: { 'User-Agent': UA, 'Referer': cssUrl } })
            if (!r.ok) return
            const buf = Buffer.from(await r.arrayBuffer())
            const ct = r.headers.get('content-type') || 'application/octet-stream'
            if (buf.length < 512_000) {
              urlMap.set(assetUrl, `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`)
            }
          } catch {}
        }))
      }

      // CSS内URLを書き換え
      cssText = cssText.replace(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/g, (_match, ref) => {
        if (ref.startsWith('data:') || ref.startsWith('#')) return _match
        try {
          const abs = new URL(ref, cssUrl).href
          return urlMap.has(abs) ? `url(${urlMap.get(abs)})` : `url(${abs})`
        } catch { return _match }
      })

      cssContents.push(cssText)
    } catch {}
  }

  // Step 3: Google Fontsの処理
  const gfRe = /href=["'](https:\/\/fonts\.googleapis\.com\/[^"']+)["']/gi
  while ((m = gfRe.exec(html)) !== null) {
    try {
      const gfRes = await fetch(m[1], { headers: { 'User-Agent': UA } })
      if (gfRes.ok) {
        let gfCss = await gfRes.text()
        // フォントファイルURL抽出＆ダウンロード
        const fontUrlRe = /url\(\s*['"]?(https:\/\/fonts\.gstatic\.com[^'")]+)['"]?\s*\)/g
        let fm: RegExpExecArray | null
        while ((fm = fontUrlRe.exec(gfCss)) !== null) {
          if (urlMap.has(fm[1])) continue
          try {
            const fr = await fetch(fm[1])
            if (fr.ok) {
              const buf = Buffer.from(await fr.arrayBuffer())
              const ct = fr.headers.get('content-type') || 'font/woff2'
              if (buf.length < 512_000) {
                urlMap.set(fm[1], `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`)
              }
            }
          } catch {}
        }
        // フォントURLを書き換え
        gfCss = gfCss.replace(/url\(\s*['"]?(https:\/\/fonts\.gstatic\.com[^'")]+)['"]?\s*\)/g, (_m, u) => {
          return urlMap.has(u) ? `url(${urlMap.get(u)})` : _m
        })
        cssContents.push(gfCss)
      }
    } catch {}
  }

  // Step 4: HTML内画像 + srcset + og:image + favicon取得
  const imgUrls: string[] = []
  // src, poster
  const srcRe = /(?:src|poster)=["'](https?:\/\/[^"']+)["']/gi
  while ((m = srcRe.exec(html)) !== null) {
    if (!urlMap.has(m[1])) imgUrls.push(m[1])
  }
  // srcset
  const srcsetRe = /srcset=["']([^"']+)["']/gi
  while ((m = srcsetRe.exec(html)) !== null) {
    for (const part of m[1].split(',')) {
      const srcsetUrl = part.trim().split(/\s+/)[0]
      if (/^https?:\/\//.test(srcsetUrl) && !urlMap.has(srcsetUrl)) imgUrls.push(srcsetUrl)
    }
  }
  // og:image, favicon
  const metaImgRe = /content=["'](https?:\/\/[^"']+\.(?:png|jpg|jpeg|svg|webp|gif|ico)[^"']*)["']/gi
  while ((m = metaImgRe.exec(html)) !== null) {
    if (!urlMap.has(m[1])) imgUrls.push(m[1])
  }

  // 並列ダウンロード（最大20同時、300KB以下のみdata URI化）
  const IMG_BATCH = 20
  const uniqueImgs = [...new Set(imgUrls)]
  for (let i = 0; i < uniqueImgs.length; i += IMG_BATCH) {
    await Promise.allSettled(uniqueImgs.slice(i, i + IMG_BATCH).map(async (imgUrl) => {
      try {
        const r = await fetch(imgUrl, { headers: { 'User-Agent': UA, 'Referer': url } })
        if (!r.ok) return
        const buf = Buffer.from(await r.arrayBuffer())
        const ct = r.headers.get('content-type') || 'image/png'
        if (buf.length < 300_000) {
          urlMap.set(imgUrl, `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`)
        }
      } catch {}
    }))
  }

  // Step 5: <style>タグ内のurl()も書き換え
  html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_match, cssBlock) => {
    let rewritten = cssBlock
    rewritten = rewritten.replace(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/g, (_m: string, ref: string) => {
      if (ref.startsWith('data:') || ref.startsWith('#')) return _m
      try {
        const abs = new URL(ref, url).href
        return urlMap.has(abs) ? `url(${urlMap.get(abs)})` : `url(${abs})`
      } catch { return _m }
    })
    return `<style>${rewritten}</style>`
  })

  // Step 6: HTML書き換え — CSSインライン化
  html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]*\/?>/gi, '')
  html = html.replace(/<link[^>]+href=["'][^"']*\.css[^"']*["'][^>]*\/?>/gi, '')
  // Google Fontsリンクも除去（インライン化済み）
  html = html.replace(/<link[^>]+href=["']https:\/\/fonts\.googleapis\.com[^"']*["'][^>]*\/?>/gi, '')

  if (cssContents.length > 0) {
    const inlineCss = `<style>\n${cssContents.join('\n')}\n</style>`
    html = html.includes('</head>') ? html.replace('</head>', `${inlineCss}\n</head>`) : inlineCss + html
  }

  // 画像URLをdata URIに置換
  for (const [origUrl, dataUri] of urlMap) {
    html = html.split(origUrl).join(dataUri)
  }

  // 相対URLを絶対URLに変換
  html = html.replace(/(src|href|poster|action)=["'](\/[^"']*?)["']/gi, (_match, attr, relPath) => {
    return `${attr}="${pageOrigin}${relPath}"`
  })

  // Step 7: 不要スクリプト除去
  html = html.replace(/<script[^>]*google(?:tagmanager|analytics)[^>]*>[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<script[^>]*gtag[^>]*>[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<script[^>]*facebook[^>]*>[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<script[^>]*fbevents[^>]*>[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<noscript>[\s\S]*?googletagmanager[\s\S]*?<\/noscript>/gi, '')
  // preconnect/prefetch除去
  html = html.replace(/<link[^>]+rel=["'](?:preconnect|prefetch|dns-prefetch)["'][^>]*\/?>/gi, '')

  // Step 8: リンク無効化（ページ内リンクは維持）
  html = html.replace(/<a\s([^>]*?)href=["'](?!#)([^"']*)["']/gi, '<a $1href="#"')

  return { html, cssUrls, urlMap }
}

/** SPA判定: body内テキストが少なすぎる or JSフレームワーク依存 */
function isSpaHtml(html: string): boolean {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (!bodyMatch) return true
  const bodyText = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  // テキストが50文字未満 = SPA（JSでレンダリングされてる可能性大）
  if (bodyText.length < 50) return true
  // __NEXT_DATA__ or <div id="app"></div> 等のSPAマーカー
  if (/<div\s+id=["'](?:app|root|__next)["']\s*>\s*<\/div>/i.test(html)) return true
  return false
}

app.post('/api/clone-page', async (req, res) => {
  const { url, forceClaude } = req.body
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: '有効なURLを指定してください' })
    return
  }

  const rlKey = `clone:${url}`
  if (!rateLimit(rlKey, 3, 60_000)) {
    res.status(429).json({ error: 'レート制限中です。少し待ってください。' })
    return
  }

  try {
    let method = 'fetch'

    if (forceClaude) {
      // ユーザーが明示的にClaude版を指定
      method = 'claude'
    } else {
      // まずfetch版を試す
      const { html, cssUrls, urlMap } = await fetchClonePage(url)

      if (isSpaHtml(html)) {
        // SPA検知 → Claude版にフォールバック
        logger.info('SPA detected, falling back to Claude clone', { url })
        method = 'claude'
      } else {
        // fetch版で成功
        const sizeKb = Math.round(Buffer.byteLength(html, 'utf-8') / 1024)
        logger.info('Page cloned (fetch)', { url, sizeKb, assets: urlMap.size, cssFiles: cssUrls.length })
        res.json({
          html,
          url,
          method: 'fetch',
          stats: {
            htmlSizeKb: sizeKb,
            cssFilesInlined: cssUrls.length,
            assetsEmbedded: urlMap.size
          }
        })
        return
      }
    }

    // Claude版
    if (method === 'claude') {
      const result = await clonePageWithClaude(url)
      res.json({
        html: result.indexHtml,
        url,
        method: 'claude',
        stats: {
          htmlSizeKb: result.stats.htmlSizeKb,
          cssFilesInlined: result.stats.cssFiles,
          assetsEmbedded: result.stats.imageFiles + result.stats.fontFiles,
          claudeFiles: result.stats.totalFiles
        }
      })
    }
  } catch (err: any) {
    logger.error('Page clone failed', { url, error: err.message })
    res.status(500).json({ error: safeErrorMessage(err) })
  }
})

// ============================================================
// Batch Page Clone — 複数URLを順次クローン、結果をローカル保存
// ============================================================
interface BatchCloneStatus {
  total: number
  done: number
  failed: number
  current: string | null
  running: boolean
  results: { url: string; ok: boolean; method?: string; sizeKb?: number; error?: string }[]
}

const batchCloneStatus: BatchCloneStatus = {
  total: 0, done: 0, failed: 0, current: null, running: false, results: []
}

app.post('/api/clone-batch', async (req, res) => {
  const { urls } = req.body
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'urls配列を指定してください' })
    return
  }

  if (batchCloneStatus.running) {
    res.status(409).json({ error: 'バッチクローンが既に実行中です', status: batchCloneStatus })
    return
  }

  const validUrls = urls
    .map((u: any) => typeof u === 'string' ? u.trim() : '')
    .filter((u: string) => /^https?:\/\//i.test(u))
    .slice(0, 500) // 最大500件

  if (validUrls.length === 0) {
    res.status(400).json({ error: '有効なURLがありません' })
    return
  }

  // Reset status
  batchCloneStatus.total = validUrls.length
  batchCloneStatus.done = 0
  batchCloneStatus.failed = 0
  batchCloneStatus.current = null
  batchCloneStatus.running = true
  batchCloneStatus.results = []

  // Start processing in background
  res.json({ message: `${validUrls.length}件のクローンを開始します`, status: batchCloneStatus })

  // クローン保存先
  const { mkdirSync, writeFileSync } = await import('fs')
  const cloneDir = path.join(process.cwd(), '.partcopy', 'clones', 'batch')
  mkdirSync(cloneDir, { recursive: true })

  // 順次処理（並列だとサーバー過負荷になるので2件ずつ）
  const CONCURRENCY = 2
  for (let i = 0; i < validUrls.length; i += CONCURRENCY) {
    const batch = validUrls.slice(i, i + CONCURRENCY)
    await Promise.allSettled(batch.map(async (targetUrl: string) => {
      batchCloneStatus.current = targetUrl
      try {
        const { html, cssUrls, urlMap } = await fetchClonePage(targetUrl)

        if (isSpaHtml(html)) {
          // SPA → スキップ（Claude版はバッチでは重すぎる）
          batchCloneStatus.failed++
          batchCloneStatus.results.push({ url: targetUrl, ok: false, error: 'SPA検知（fetch不可）' })
          return
        }

        // ファイル名をドメインから生成
        const domain = new URL(targetUrl).hostname.replace(/^www\./, '')
        const safeName = domain.replace(/[^a-z0-9.-]/gi, '_')
        const filePath = path.join(cloneDir, `${safeName}.html`)
        writeFileSync(filePath, html, 'utf-8')

        const sizeKb = Math.round(Buffer.byteLength(html, 'utf-8') / 1024)
        batchCloneStatus.done++
        batchCloneStatus.results.push({
          url: targetUrl, ok: true, method: 'fetch', sizeKb
        })

        logger.info('Batch clone ok', { url: targetUrl, sizeKb, css: cssUrls.length, assets: urlMap.size })
      } catch (err: any) {
        batchCloneStatus.failed++
        batchCloneStatus.results.push({ url: targetUrl, ok: false, error: err.message?.slice(0, 100) })
        logger.warn('Batch clone failed', { url: targetUrl, error: err.message })
      }
    }))

    // 各バッチ間に500ms待機（サーバー負荷軽減）
    await new Promise(r => setTimeout(r, 500))
  }

  batchCloneStatus.current = null
  batchCloneStatus.running = false
  logger.info('Batch clone complete', {
    total: batchCloneStatus.total,
    done: batchCloneStatus.done,
    failed: batchCloneStatus.failed
  })
})

app.get('/api/clone-batch/status', (_req, res) => {
  res.json(batchCloneStatus)
})

app.get('/api/clone-batch/url-list', async (req, res) => {
  const count = Math.min(Math.max(Number(req.query.count) || 100, 1), 500)
  const { readFileSync, existsSync } = await import('fs')

  // URLリストファイルを順に探す
  const candidates = ['urls-1000.txt', 'urls-2000-extra.txt', 'urls-extra-2600.txt']
  let allUrls: string[] = []
  for (const file of candidates) {
    const filePath = path.join(process.cwd(), file)
    if (existsSync(filePath)) {
      const lines = readFileSync(filePath, 'utf-8').split('\n')
        .map(l => l.trim())
        .filter(l => /^https?:\/\//i.test(l))
      allUrls.push(...lines)
    }
  }

  // 既にクローン済みのURLを除外
  const cloneDir = path.join(process.cwd(), '.partcopy', 'clones', 'batch')
  let clonedDomains = new Set<string>()
  try {
    const { readdirSync } = await import('fs')
    clonedDomains = new Set(readdirSync(cloneDir).filter(f => f.endsWith('.html')).map(f => f.replace('.html', '')))
  } catch {}

  const unclonedUrls = allUrls.filter(u => {
    try {
      const domain = new URL(u).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '_')
      return !clonedDomains.has(domain)
    } catch { return false }
  })

  res.json({ urls: unclonedUrls.slice(0, count), total: allUrls.length, remaining: unclonedUrls.length })
})

app.get('/api/clone-batch/list', async (_req, res) => {
  const { readdirSync, statSync } = await import('fs')
  const cloneDir = path.join(process.cwd(), '.partcopy', 'clones', 'batch')
  try {
    const files = readdirSync(cloneDir)
      .filter(f => f.endsWith('.html'))
      .map(f => {
        const stat = statSync(path.join(cloneDir, f))
        return { name: f, sizeKb: Math.round(stat.size / 1024), date: stat.mtime.toISOString() }
      })
      .sort((a, b) => b.date.localeCompare(a.date))
    res.json({ files, total: files.length })
  } catch {
    res.json({ files: [], total: 0 })
  }
})

app.get('/api/clone-batch/file/:name', async (req, res) => {
  const { readFileSync, existsSync } = await import('fs')
  const filePath = path.join(process.cwd(), '.partcopy', 'clones', 'batch', req.params.name)
  if (!existsSync(filePath) || !req.params.name.endsWith('.html')) {
    res.status(404).json({ error: 'ファイルが見つかりません' })
    return
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(readFileSync(filePath, 'utf-8'))
})

// ============================================================
// Gemini Design Edit
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''

app.post('/api/gemini/design-edit', async (req, res) => {
  if (!GEMINI_API_KEY) {
    res.status(500).json({ error: 'GEMINI_API_KEY が設定されていません' })
    return
  }

  const { html, prompt, sectionId } = req.body
  if (!html || !prompt) {
    res.status(400).json({ error: 'html と prompt は必須です' })
    return
  }

  // Rate limit per sectionId
  const rlKey = `gemini:${sectionId || 'global'}`
  if (!rateLimit(rlKey, 10, 60_000)) {
    res.status(429).json({ error: 'レート制限中です。少し待ってから再試行してください。' })
    return
  }

  try {
    const systemPrompt = `あなたはWebデザインの専門家です。ユーザーから渡されるHTMLセクションのデザインを、指示に従って修正してください。

ルール：
- HTMLの構造（タグ、クラス名、ID）はできるだけ維持してください
- style属性やinline CSSを変更・追加してデザインを修正してください
- <style>タグ内のCSSも修正できます
- テキスト内容は変更しないでください（デザインのみ変更）
- 画像のsrcは変更しないでください
- レスポンシブデザインを意識してください
- 修正後の完全なHTMLを返してください

回答フォーマット：
必ず以下のJSON形式で返してください。他のテキストは含めないでください。
{"html": "修正後のHTML全体", "explanation": "変更内容の日本語での説明"}`

    const requestBody = {
      contents: [{
        parts: [{
          text: `${systemPrompt}\n\n--- 現在のHTML ---\n${html.slice(0, 100000)}\n\n--- 変更指示 ---\n${prompt}`
        }]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 65536,
        responseMimeType: 'application/json'
      }
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    )

    if (!geminiRes.ok) {
      const errText = await geminiRes.text()
      logger.error('Gemini API error', { status: geminiRes.status, body: errText.slice(0, 500) })
      throw new Error(`Gemini API エラー (${geminiRes.status})`)
    }

    const geminiData = await geminiRes.json() as any
    const textContent = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!textContent) {
      throw new Error('Gemini からの応答が空です')
    }

    // Parse the JSON response
    let parsed: { html?: string; explanation?: string }
    try {
      parsed = JSON.parse(textContent)
    } catch {
      // Try to extract JSON from the response
      const jsonMatch = textContent.match(/\{[\s\S]*"html"[\s\S]*\}/)
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0])
      } else {
        throw new Error('Gemini の応答をパースできませんでした')
      }
    }

    if (!parsed.html) {
      throw new Error('Gemini の応答にHTMLが含まれていません')
    }

    res.json({
      html: parsed.html,
      explanation: parsed.explanation || 'デザインを変更しました。'
    })
  } catch (err: any) {
    logger.error('Gemini design edit failed', { error: err.message })
    res.status(500).json({ error: err.message || 'Gemini API 呼び出しに失敗しました' })
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
