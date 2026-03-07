/**
 * API Server - Lightweight. No Puppeteer.
 * Creates jobs, serves results from Supabase.
 */
import express from 'express'
import cors from 'cors'
import { supabaseAdmin, STORAGE_BUCKETS } from './supabase.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

// ============================================================
// Extract: Create a crawl job
// ============================================================
app.post('/api/extract', async (req, res) => {
  const { url, genre, tags } = req.body
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'URL is required' })
    return
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    res.status(400).json({ error: 'Invalid URL format' })
    return
  }

  try {
    const domain = parsedUrl.hostname.replace(/^www\./, '')

    // Upsert source_site
    const { data: site, error: siteErr } = await supabaseAdmin
      .from('source_sites')
      .upsert({
        normalized_domain: domain,
        homepage_url: url,
        genre: genre || '',
        tags: tags || [],
        status: 'queued'
      }, { onConflict: 'normalized_domain' })
      .select()
      .single()

    if (siteErr || !site) {
      res.status(500).json({ error: siteErr?.message || 'Failed to create site' })
      return
    }

    // Create crawl_run
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
      res.status(500).json({ error: jobErr?.message || 'Failed to create job' })
      return
    }

    res.json({ jobId: job.id, siteId: site.id, status: 'queued' })
  } catch (err: any) {
    console.error('Extract error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// Job status
// ============================================================
app.get('/api/jobs/:id', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('crawl_runs')
    .select('*, source_sites(normalized_domain, genre, tags)')
    .eq('id', req.params.id)
    .single()

  if (error || !data) {
    res.status(404).json({ error: 'Job not found' })
    return
  }
  res.json({ job: data })
})

// ============================================================
// Get sections for a crawl run (with signed thumbnail URLs)
// ============================================================
app.get('/api/jobs/:id/sections', async (req, res) => {
  const { data: sections, error } = await supabaseAdmin
    .from('source_sections')
    .select('*, source_pages(url, title)')
    .eq('page_id', (
      // Get page_id from crawl_run
      await supabaseAdmin
        .from('source_pages')
        .select('id')
        .eq('crawl_run_id', req.params.id)
        .limit(1)
        .single()
    ).data?.id || '')
    .order('order_index')

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  // Generate signed URLs for thumbnails
  const sectionsWithUrls = await Promise.all((sections || []).map(async (s: any) => {
    let thumbnailUrl: string | null = null
    if (s.thumbnail_storage_path) {
      const { data } = await supabaseAdmin.storage
        .from(STORAGE_BUCKETS.SECTION_THUMBNAILS)
        .createSignedUrl(s.thumbnail_storage_path, 3600)
      thumbnailUrl = data?.signedUrl || null
    }
    return { ...s, thumbnailUrl }
  }))

  res.json({ sections: sectionsWithUrls })
})

// ============================================================
// Library: Get all sections with filters
// ============================================================
app.get('/api/library', async (req, res) => {
  const { genre, family, industry, limit: lim } = req.query
  let query = supabaseAdmin
    .from('source_sections')
    .select('*, source_sites!inner(normalized_domain, genre, tags, industry)')
    .order('created_at', { ascending: false })
    .limit(Number(lim) || 100)

  if (genre && typeof genre === 'string') {
    query = query.eq('source_sites.genre', genre)
  }
  if (family && typeof family === 'string') {
    query = query.eq('block_family', family)
  }
  if (industry && typeof industry === 'string') {
    query = query.eq('source_sites.industry', industry)
  }

  const { data, error } = await query

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  // Sign thumbnail URLs
  const results = await Promise.all((data || []).map(async (s: any) => {
    let thumbnailUrl: string | null = null
    if (s.thumbnail_storage_path) {
      const { data: urlData } = await supabaseAdmin.storage
        .from(STORAGE_BUCKETS.SECTION_THUMBNAILS)
        .createSignedUrl(s.thumbnail_storage_path, 3600)
      thumbnailUrl = urlData?.signedUrl || null
    }
    return { ...s, thumbnailUrl }
  }))

  res.json({ sections: results })
})

// ============================================================
// Library: Genre summary
// ============================================================
app.get('/api/library/genres', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('source_sites')
    .select('genre')

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  const counts: Record<string, number> = {}
  for (const row of data || []) {
    const g = row.genre || 'untagged'
    counts[g] = (counts[g] || 0) + 1
  }

  res.json({
    genres: Object.entries(counts)
      .map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count)
  })
})

// ============================================================
// Library: Block family summary
// ============================================================
app.get('/api/library/families', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('block_families')
    .select('key, label, label_ja, sort_order')
    .order('sort_order')

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ families: data })
})

// ============================================================
// Block variants
// ============================================================
app.get('/api/block-variants', async (req, res) => {
  const { family } = req.query
  let query = supabaseAdmin
    .from('block_variants')
    .select('*, block_families(label, label_ja)')
    .order('family_key')

  if (family && typeof family === 'string') {
    query = query.eq('family_key', family)
  }

  const { data, error } = await query
  if (error) {
    res.status(500).json({ error: error.message })
    return
  }
  res.json({ variants: data })
})

// ============================================================
// Delete section from library
// ============================================================
app.delete('/api/library/:id', async (req, res) => {
  const { error } = await supabaseAdmin
    .from('source_sections')
    .delete()
    .eq('id', req.params.id)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }
  res.json({ deleted: true })
})

const PORT = 3001
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`)
})
