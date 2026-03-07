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
  // Get page for this crawl run
  const { data: pageData } = await supabaseAdmin
    .from('source_pages')
    .select('id, css_bundle_path, url')
    .eq('crawl_run_id', req.params.id)
    .limit(1)
    .single()

  if (!pageData) {
    res.status(404).json({ error: 'Page not found for this job' })
    return
  }

  const { data: sections, error } = await supabaseAdmin
    .from('source_sections')
    .select('*, source_pages(url, title)')
    .eq('page_id', pageData.id)
    .order('order_index')

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  // Download the CSS bundle once (shared across all sections)
  let cssBundle = ''
  if (pageData.css_bundle_path) {
    const { data: cssFile } = await supabaseAdmin.storage
      .from(STORAGE_BUCKETS.RAW_HTML)
      .download(pageData.css_bundle_path)
    if (cssFile) cssBundle = await cssFile.text()
  }

  const pageOrigin = pageData.url ? new URL(pageData.url).origin : ''

  // Return sections with htmlUrl pointing to our render endpoint
  const sectionsWithUrls = (sections || []).map((s: any) => ({
    ...s,
    htmlUrl: s.raw_html_storage_path ? `/api/sections/${s.id}/render` : null,
    cssSize: cssBundle.length
  }))

  res.json({ sections: sectionsWithUrls })
})

// ============================================================
// Render: Serve self-contained HTML for a section (CSS inlined)
// ============================================================
// Cache CSS bundles per page to avoid re-downloading
const cssBundleCache = new Map<string, { css: string; origin: string; expiry: number }>()

app.get('/api/sections/:sectionId/render', async (req, res) => {
  const { sectionId } = req.params

  // Get section + page info
  const { data: section } = await supabaseAdmin
    .from('source_sections')
    .select('raw_html_storage_path, page_id')
    .eq('id', sectionId)
    .single()

  if (!section?.raw_html_storage_path) {
    res.status(404).send('Section not found')
    return
  }

  const { data: page } = await supabaseAdmin
    .from('source_pages')
    .select('css_bundle_path, url')
    .eq('id', section.page_id)
    .single()

  if (!page) {
    res.status(404).send('Page not found')
    return
  }

  const pageOrigin = page.url ? new URL(page.url).origin : ''

  // Get CSS bundle (cached)
  let cssBundle = ''
  const cacheKey = section.page_id
  const cached = cssBundleCache.get(cacheKey)
  if (cached && cached.expiry > Date.now()) {
    cssBundle = cached.css
  } else if (page.css_bundle_path) {
    const { data: cssFile } = await supabaseAdmin.storage
      .from(STORAGE_BUCKETS.RAW_HTML)
      .download(page.css_bundle_path)
    if (cssFile) {
      cssBundle = await cssFile.text()
      cssBundleCache.set(cacheKey, { css: cssBundle, origin: pageOrigin, expiry: Date.now() + 600000 })
    }
  }

  // Download section raw HTML
  const { data: rawFile } = await supabaseAdmin.storage
    .from(STORAGE_BUCKETS.RAW_HTML)
    .download(section.raw_html_storage_path)

  if (!rawFile) {
    res.status(404).send('HTML not found')
    return
  }

  const sectionHtml = await rawFile.text()

  // v3 sections already have rewritten URLs (signed Supabase URLs)
  // <base> tag handles any remaining relative URLs
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<base href="${pageOrigin}/">
<style>${cssBundle}</style>
</head>
<body style="margin:0;padding:0">${sectionHtml}</body>
</html>`

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.send(html)
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

  // Use render endpoint for HTML URLs
  const results = (data || []).map((s: any) => ({
    ...s,
    htmlUrl: s.raw_html_storage_path ? `/api/sections/${s.id}/render` : null
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

// ============================================================
// Source Edit: Get DOM nodes for a section
// ============================================================
app.get('/api/sections/:sectionId/dom', async (req, res) => {
  const { sectionId } = req.params

  // Get latest resolved snapshot
  const { data: snapshot } = await supabaseAdmin
    .from('section_dom_snapshots')
    .select('id, html_storage_path, dom_json_path, node_count, css_strategy')
    .eq('section_id', sectionId)
    .eq('snapshot_type', 'resolved')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!snapshot) {
    res.status(404).json({ error: 'No editable snapshot found' })
    return
  }

  // Get editable nodes
  const { data: nodes, error } = await supabaseAdmin
    .from('section_nodes')
    .select('*')
    .eq('snapshot_id', snapshot.id)
    .order('order_index')

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({
    snapshotId: snapshot.id,
    htmlStoragePath: snapshot.html_storage_path,
    nodeCount: snapshot.node_count,
    nodes: nodes || []
  })
})

// ============================================================
// Source Edit: Render resolved HTML (with data-pc-key attributes)
// ============================================================
app.get('/api/sections/:sectionId/editable-render', async (req, res) => {
  const { sectionId } = req.params

  // Get latest resolved snapshot
  const { data: snapshot } = await supabaseAdmin
    .from('section_dom_snapshots')
    .select('html_storage_path, section_id')
    .eq('section_id', sectionId)
    .eq('snapshot_type', 'resolved')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!snapshot?.html_storage_path) {
    res.status(404).send('No editable snapshot')
    return
  }

  // Get section → page → CSS bundle
  const { data: section } = await supabaseAdmin
    .from('source_sections')
    .select('page_id')
    .eq('id', sectionId)
    .single()

  if (!section) { res.status(404).send('Section not found'); return }

  const { data: page } = await supabaseAdmin
    .from('source_pages')
    .select('css_bundle_path, url')
    .eq('id', section.page_id)
    .single()

  if (!page) { res.status(404).send('Page not found'); return }

  const pageOrigin = page.url ? new URL(page.url).origin : ''

  // CSS bundle (cached)
  let cssBundle = ''
  const cacheKey = `edit_${section.page_id}`
  const cached = cssBundleCache.get(cacheKey)
  if (cached && cached.expiry > Date.now()) {
    cssBundle = cached.css
  } else if (page.css_bundle_path) {
    const { data: cssFile } = await supabaseAdmin.storage
      .from(STORAGE_BUCKETS.RAW_HTML)
      .download(page.css_bundle_path)
    if (cssFile) {
      cssBundle = await cssFile.text()
      cssBundleCache.set(cacheKey, { css: cssBundle, origin: pageOrigin, expiry: Date.now() + 600000 })
    }
  }

  // Download resolved HTML
  const { data: htmlFile } = await supabaseAdmin.storage
    .from(STORAGE_BUCKETS.SANITIZED_HTML)
    .download(snapshot.html_storage_path)

  if (!htmlFile) { res.status(404).send('HTML not found'); return }

  let sectionHtml = await htmlFile.text()

  // relative URL → absolute
  sectionHtml = sectionHtml.replace(
    /(src|href|srcset|poster|action)=(['"])(?!data:|https?:\/\/|\/\/|#|mailto:|tel:|javascript:)(\/?)((?:(?!\2).)*)\2/gi,
    (_: any, attr: string, q: string, slash: string, path: string) =>
      `${attr}=${q}${pageOrigin}${slash ? '/' : '/'}${path}${q}`
  )

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

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<base href="${pageOrigin}/">
<style>${cssBundle}</style>
<style>
  [data-pc-key] { cursor: pointer; transition: outline 0.15s; }
  [data-pc-key]:hover { outline: 2px solid rgba(59,130,246,0.4); }
  [data-pc-selected] { outline: 2px solid #3b82f6 !important; box-shadow: 0 0 0 4px rgba(59,130,246,0.15); }
</style>
</head>
<body style="margin:0;padding:0">${sectionHtml}${editorScript}</body>
</html>`

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(html)
})

// ============================================================
// Patch Sets: Create
// ============================================================
app.post('/api/sections/:sectionId/patch-sets', async (req, res) => {
  const { sectionId } = req.params
  const { projectId, label } = req.body

  // Get latest snapshot
  const { data: snapshot } = await supabaseAdmin
    .from('section_dom_snapshots')
    .select('id')
    .eq('section_id', sectionId)
    .eq('snapshot_type', 'resolved')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!snapshot) {
    res.status(404).json({ error: 'No snapshot found' })
    return
  }

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

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }
  res.json({ patchSet: data })
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

  // Validate
  const VALID_OPS = ['set_text', 'set_attr', 'replace_asset', 'remove_node', 'insert_after', 'move_node', 'set_style_token', 'set_class']
  for (const p of patches) {
    if (!p.nodeStableKey || !VALID_OPS.includes(p.op)) {
      res.status(400).json({ error: `Invalid patch: ${JSON.stringify(p)}` })
      return
    }
    // Block dangerous attrs
    if (p.op === 'set_attr' && /^on/i.test(p.payload?.attr)) {
      res.status(400).json({ error: 'Event handler attributes are not allowed' })
      return
    }
  }

  // Get current max order_index
  const { data: existing } = await supabaseAdmin
    .from('section_patches')
    .select('order_index')
    .eq('patch_set_id', patchSetId)
    .order('order_index', { ascending: false })
    .limit(1)

  let nextIndex = (existing?.[0]?.order_index ?? -1) + 1

  const records = patches.map((p: any) => ({
    patch_set_id: patchSetId,
    node_stable_key: p.nodeStableKey,
    op: p.op,
    payload_jsonb: p.payload || {},
    order_index: nextIndex++
  }))

  const { data, error } = await supabaseAdmin
    .from('section_patches')
    .insert(records)
    .select()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  // Update patch_set updated_at
  await supabaseAdmin
    .from('section_patch_sets')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', patchSetId)

  res.json({ patches: data })
})

// ============================================================
// Patch Sets: Get all patches for a set
// ============================================================
app.get('/api/patch-sets/:patchSetId', async (req, res) => {
  const { patchSetId } = req.params

  const { data: patchSet } = await supabaseAdmin
    .from('section_patch_sets')
    .select('*')
    .eq('id', patchSetId)
    .single()

  if (!patchSet) {
    res.status(404).json({ error: 'Patch set not found' })
    return
  }

  const { data: patches } = await supabaseAdmin
    .from('section_patches')
    .select('*')
    .eq('patch_set_id', patchSetId)
    .order('order_index')

  res.json({ patchSet, patches: patches || [] })
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
    // block_variant_id is required by schema — use a default
    const { data: defaultVariant } = await supabaseAdmin
      .from('block_variants')
      .select('id')
      .limit(1)
      .single()
    record.block_variant_id = defaultVariant?.id
  } else {
    record.source_block_instance_id = blockInstanceId
    const { data: instance } = await supabaseAdmin
      .from('block_instances')
      .select('block_variant_id')
      .eq('id', blockInstanceId)
      .single()
    record.block_variant_id = instance?.block_variant_id
  }

  const { data, error } = await supabaseAdmin
    .from('project_page_blocks')
    .insert(record)
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }
  res.json({ block: data })
})

const PORT = 3001
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`)
})
