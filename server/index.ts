/**
 * API Server - Lightweight. No Puppeteer.
 * Creates jobs, serves results from Supabase.
 */
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

  const { data: page } = await supabaseAdmin
    .from('source_pages')
    .select('id, css_bundle_path, url')
    .eq('crawl_run_id', jobId)
    .limit(1)
    .single()

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
    .select('id, page_id, raw_html_storage_path, sanitized_html_storage_path')
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
    .limit(Math.max(filters.limit * 3, 180))

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
  if (HAS_SUPABASE) {
    res.status(404).send('Not found in local mode')
    return
  }

  const { siteId, jobId } = req.params
  const rest = (req.params as any)[0] as string // e.g. "img/5-1-1.png" or "bundle.css"
  const storagePath = `${siteId}/${jobId}/${rest}`

  try {
    const { buffer, contentType } = await getStoredFileResponse(STORAGE_BUCKETS.RAW_HTML, storagePath)
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(buffer)
  } catch {
    // Fallback: try sanitized-html bucket
    try {
      const { buffer, contentType } = await getStoredFileResponse(STORAGE_BUCKETS.SANITIZED_HTML, storagePath)
      res.setHeader('Content-Type', contentType)
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
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// Job status
// ============================================================
app.get('/api/jobs/:id', async (req, res) => {
  const job = await getJobRecord(req.params.id)
  if (!job) {
    res.status(404).json({ error: 'Job not found' })
    return
  }
  res.json({ job })
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
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// Render: Serve section HTML + CSS bundle via <link>
// ============================================================
app.get('/api/sections/:sectionId/render', async (req, res) => {
  const { sectionId } = req.params
  try {
    const record = await getRenderContext(sectionId)
    if (!record?.section) {
      res.status(404).send('Section not found')
      return
    }

    if (!record.section.raw_html_storage_path && !record.section.sanitized_html_storage_path) {
      res.status(404).send('Section not found')
      return
    }

    const pageOrigin = record.page.url ? new URL(record.page.url).origin : ''

    // Prefer raw HTML (small, with clean /assets/ URLs)
    let storedHtml = await readBucketText(STORAGE_BUCKETS.RAW_HTML, record.section.raw_html_storage_path)
    if (!storedHtml) {
      storedHtml = await readBucketText(STORAGE_BUCKETS.SANITIZED_HTML, record.section.sanitized_html_storage_path)
    }

    if (!storedHtml) {
      res.status(404).send('HTML not found')
      return
    }

    // Link to CSS bundle file instead of inlining (much smaller response)
    const cssBundlePath = record.page.css_bundle_path
    const cssLink = cssBundlePath ? `<link rel="stylesheet" href="/assets/${cssBundlePath}">` : ''

    // If HTML still has relative URLs (not rewritten to /assets/), inject <base> so they resolve to origin
    const hasUnresolvedRelativeUrls = /(?:src|href)=["'](?!https?:\/\/|\/\/|data:|#|mailto:|tel:|javascript:|\/?assets\/)/.test(storedHtml)
    const useBase = hasUnresolvedRelativeUrls && pageOrigin

    const html = buildRenderDocument(storedHtml, pageOrigin, { extraHead: cssLink, skipBase: !useBase })

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(html)
  } catch (err: any) {
    res.status(500).send(err.message || 'Render failed')
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
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// Library: Genre summary
// ============================================================
app.get('/api/library/genres', async (req, res) => {
  try {
    res.json({ genres: await getGenreResults() })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// Library: Block family summary
// ============================================================
app.get('/api/library/families', async (req, res) => {
  try {
    res.json({ families: await getFamilyResults() })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// Block variants
// ============================================================
app.get('/api/block-variants', async (req, res) => {
  try {
    res.json({ variants: await getBlockVariantResults(typeof req.query.family === 'string' ? req.query.family : undefined) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
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
    res.status(500).json({ error: err.message })
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
    res.status(500).json({ error: err.message })
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
    res.status(500).json({ error: err.message })
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
    res.status(500).json({ error: err.message })
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
    res.status(500).json({ error: err.message })
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

    const pageOrigin = record.page.url ? new URL(record.page.url).origin : ''

    let sectionHtml = await readBucketText(STORAGE_BUCKETS.SANITIZED_HTML, record.resolvedSnapshot.html_storage_path)
    if (!sectionHtml) {
      res.status(404).send('HTML not found')
      return
    }

    // CSS bundle via <link> (resolved inline HTMLの場合でもCSSは必要ない場合がある)
    const cssBundlePath = record.page.css_bundle_path
    const cssLink = cssBundlePath ? `<link rel="stylesheet" href="/assets/${cssBundlePath}">` : ''

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

    const hasUnresolvedRelativeUrls = /(?:src|href)=["'](?!https?:\/\/|\/\/|data:|#|mailto:|tel:|javascript:|\/?assets\/)/.test(sectionHtml)
    const useBase = hasUnresolvedRelativeUrls && pageOrigin

    const html = buildRenderDocument(sectionHtml, pageOrigin, {
      skipBase: !useBase,
      extraHead: `${cssLink}<style>
  [data-pc-key] { cursor: pointer; transition: outline 0.15s; }
  [data-pc-key]:hover { outline: 2px solid rgba(59,130,246,0.4); }
  [data-pc-selected] { outline: 2px solid #3b82f6 !important; box-shadow: 0 0 0 4px rgba(59,130,246,0.15); }
</style>`,
      extraBodyEnd: editorScript
    })

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  } catch (err: any) {
    res.status(500).send(err.message || 'Editable render failed')
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
    res.status(500).json({ error: err.message })
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
    res.status(500).json({ error: err.message })
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
    res.status(500).json({ error: err.message })
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
