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
  upsertSourceSite
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
  scopeCss
} from './render-utils.js'

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
  const { scopedCss, fontFaceCss } = scopeCss(cssBundle, scopeClass)

  return {
    sectionId,
    blockFamily: record.section.block_family || 'section',
    scopeClass,
    html: resolveRelativeUrls(html, pageOrigin),
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

async function createExtractJobRecord(url: string, genre: string, tags: string[]) {
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
      status: 'queued'
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
      status: 'queued'
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
    const page = await getPageByCrawlRun(jobId)
    if (!page) return null
    const sections = await getSectionsByPage(page.id)
    return { page, sections }
  }

  const { data: page, error: pageError } = await supabaseAdmin
    .from('source_pages')
    .select('id, css_bundle_path, url')
    .eq('crawl_run_id', jobId)
    .maybeSingle()

  if (pageError) throw new Error(pageError.message)
  if (!page) return null

  const { data: sections, error } = await supabaseAdmin
    .from('source_sections')
    .select('*, source_pages(url, title)')
    .eq('page_id', page.id)
    .order('order_index')

  if (error) throw new Error(error.message)
  return { page, sections: sections || [] }
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
app.get('/assets/:siteId/:jobId/*', async (req, res) => {
  const { siteId, jobId } = req.params
  const filePath = (req.params as Record<string, string>)[0]
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

  // Local mode - serve from local storage
  try {
    const { buffer, contentType: localContentType } = await getStoredFileResponse(STORAGE_BUCKETS.RAW_HTML, storagePath)
    res.setHeader('Content-Type', localContentType)
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(buffer)
  } catch {
    // Fallback: try sanitized-html bucket
    try {
      const { buffer, contentType: localContentType } = await getStoredFileResponse(STORAGE_BUCKETS.SANITIZED_HTML, storagePath)
      res.setHeader('Content-Type', localContentType)
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.send(buffer)
    } catch {
      res.status(404).send('File not found')
    }
  }
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

  const { url, genre, tags } = req.body
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

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    res.status(400).json({ error: 'Invalid URL format' })
    return
  }

  try {
    const { site, job } = await createExtractJobRecord(url, genre || '', Array.isArray(tags) ? tags : [])

    res.json({ jobId: job.id, siteId: site.id, status: 'queued' })
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
      htmlUrl: (section.sanitized_html_storage_path || section.raw_html_storage_path) ? `/api/sections/${section.id}/render` : null
    }))

    res.json({ sections })
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
        htmlUrl: (section.sanitized_html_storage_path || section.raw_html_storage_path) ? `/api/sections/${section.id}/render` : null
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

    // Inject scoped CSS into the TSX component
    const cssComment = allCss
      ? `\n// Scoped CSS for this section\nconst scopedCss = ${JSON.stringify(allCss)};\n`
      : ''

    res.json({ tsx: cssComment + tsx, blockFamily, scopeClass })
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
  const { sectionIds } = req.body as { sectionIds: string[] }

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

    const ensureExportAsset = async (sourceUrl: string) => {
      if (exportAssetPathBySource.has(sourceUrl)) {
        return exportAssetPathBySource.get(sourceUrl)
      }

      const resolvedAsset = await loadExportAssetSource(sourceUrl)
      if (!resolvedAsset) return undefined

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

    const components: { name: string; tsx: string }[] = []

    for (const prepared of preparedSections) {
      const sectionAssetUrls = dedupeStrings([
        ...collectHtmlAssetUrls(prepared.html),
        ...collectCssAssetUrls(prepared.css),
        ...prepared.fontFaceCss.flatMap((block) => collectCssAssetUrls(block))
      ])

      for (const sourceUrl of sectionAssetUrls) {
        await ensureExportAsset(sourceUrl)
      }

      const html = rewriteHtmlAssetUrls(prepared.html, (url) => exportAssetPathBySource.get(url))
      const css = rewriteCssUrls(prepared.css, (url) => exportAssetPathBySource.get(url))
      const fontFaceCss = prepared.fontFaceCss.map((block) => rewriteCssUrls(block, (url) => exportAssetPathBySource.get(url)))
      globalFontFaceCss.push(...fontFaceCss)

      const componentBaseName = `${toPascalCase(prepared.blockFamily)}Section`
      const duplicateIndex = componentCounts.get(componentBaseName) || 0
      componentCounts.set(componentBaseName, duplicateIndex + 1)
      const componentName = duplicateIndex === 0 ? componentBaseName : `${componentBaseName}${duplicateIndex}`

      const escapedHtml = escapeTemplateLiteral(html)
      const escapedCss = escapeTemplateLiteral(css)

      const tsx = `export default function ${componentName}() {\n  return (\n    <>\n${escapedCss ? `      <style dangerouslySetInnerHTML={{ __html: \`${escapedCss}\` }} />\n` : ''}      <section className="${prepared.scopeClass}" data-partcopy-section="${prepared.sectionId}" dangerouslySetInnerHTML={{ __html: \`${escapedHtml}\` }} />\n    </>\n  )\n}\n`

      components.push({ name: componentName, tsx })
    }

    const imports = components.map((component) => `import ${component.name} from './components/${component.name}'`).join('\n')
    const renders = components.map((component) => `      <${component.name} />`).join('\n')
    const appTsx = `${imports}\n\nexport default function App() {\n  return (\n    <main className="pc-preview-page">\n${renders}\n    </main>\n  )\n}\n`

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
        react: '^18.3.1',
        'react-dom': '^18.3.1'
      },
      devDependencies: {
        '@types/react': '^18.3.12',
        '@types/react-dom': '^18.3.1',
        '@vitejs/plugin-react': '^4.3.4',
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

    const viteConfig = `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n`

    const indexCss = `${dedupeCssBlocks([PARTCOPY_BASE_CSS, ...globalFontFaceCss]).join('\n\n')}\n`

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
    const claudeMd = `# CLAUDE.md

このプロジェクトはPARTCOPYで生成されたReact + TypeScript + ViteのWebサイトです。

## 起動方法
\`\`\`bash
npm install
npm run dev
\`\`\`
http://localhost:5173 でブラウザ確認できます。

## 技術スタック
- React 18 + TypeScript
- Vite 6
- アセットは \`public/assets/\` にローカル同梱

## プロジェクト構造
- \`src/App.tsx\` — メインコンポーネント。全セクションをここでimportして縦に並べている
- \`src/components/\` — 各セクションのTSXコンポーネント
- \`src/index.css\` — ベースCSS + 重複排除済みフォント定義
- \`public/assets/\` — 画像・フォント・背景画像
- \`vite.config.ts\` — Vite + React 設定

## よくある作業
- 「テキストを変えて」→ 各コンポーネント内の日本語テキストを編集
- 「画像を差し替えて」→ \`public/assets/\` 内の該当ファイルを差し替える
- 「セクションを並び替えて」→ src/App.tsx のコンポーネント順序を変更
- 「セクションを削除して」→ src/App.tsx からimportとJSXを削除
- 「ビルドして」→ npm run build → dist/ に出力
- 「デプロイして」→ dist/ をVercel/Netlify等にアップロード

## 注意
- セクションCSSは \`.pc-sec-*\` でスコープされています
- 画像URLはローカルファイルに変換済みです
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
    archive.append(indexCss, { name: 'src/index.css' })

    for (const comp of components) {
      archive.append(comp.tsx, { name: `src/components/${comp.name}.tsx` })
    }

    for (const asset of exportAssets) {
      archive.append(asset.buffer, { name: `public${asset.exportPath}`.replace(/^\//, '') })
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
      res.json({ projects: [] })
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
      res.json({ project: { id: crypto.randomUUID(), name, canvas_json: [], created_at: new Date().toISOString() } })
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
      res.json({ ok: true })
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/projects/:id', async (req, res) => {
  try {
    if (HAS_SUPABASE) {
      await supabaseAdmin.from('projects').delete().eq('id', req.params.id)
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
