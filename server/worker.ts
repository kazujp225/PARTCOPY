/**
 * Extract Worker v3 - Complete Site Download
 *
 * Pipeline:
 * 1. downloadSite: HTML/CSS/画像/フォントを全て直接ダウンロード → URL書き換え
 * 2. Section detection (Puppeteer page.evaluate)
 * 3. Classify + Canonicalize + Store each section (with rewritten URLs)
 * 4. DOM snapshot for editing
 */
import {
  claimQueuedJob,
  createSectionDomSnapshot,
  createSourcePage,
  createSourceSection,
  failCrawlRun,
  findBlockVariantByKey,
  insertBlockInstance,
  insertPageAssets,
  insertSectionNodes,
  updateCrawlRun,
  updateSourceSite,
  writeStoredFile
} from './local-store.js'
import { HAS_SUPABASE, supabaseAdmin } from './supabase.js'
import { STORAGE_BUCKETS } from './storage-config.js'
import { launchBrowser } from './capture-runner.js'
import { downloadSite } from './site-downloader.js'
import { detectSections, screenshotSection } from './section-detector.js'
import { extractStyleSummary, generateLayoutSignature } from './style-extractor.js'
import { classifySection, type RawSection } from './classifier.js'
import { canonicalizeSection } from './canonicalizer.js'
import { parseSectionDOM } from './dom-parser.js'

const WORKER_ID = `worker-${process.pid}`
const POLL_INTERVAL = 3000

async function uploadBuffer(bucket: string, path: string, data: Buffer | string, contentType: string): Promise<string> {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data

  if (!HAS_SUPABASE) {
    await writeStoredFile(bucket, path, buffer, contentType)
    return path
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabaseAdmin.storage.from(bucket).upload(path, buffer, { contentType, upsert: true })
    if (!error) return path
    if (attempt < 2 && /timeout|gateway|5\d\d/i.test(error.message)) {
      console.warn(`Upload retry ${attempt + 1} for ${bucket}/${path}: ${error.message}`)
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
      continue
    }
    throw new Error(`Storage upload failed (${bucket}/${path}): ${error.message}`)
  }
  return path
}

function rewriteStoredHtml(
  html: string,
  finalPageUrl: string,
  pageOrigin: string,
  sortedEntries: Array<[string, string]>,
  urlMap: Map<string, string>
) {
  let nextHtml = html

  for (const [originalUrl, signedUrl] of sortedEntries) {
    nextHtml = nextHtml.split(originalUrl).join(signedUrl)
  }

  nextHtml = nextHtml.replace(
    /(src|href|poster|action)=(["'])(?!data:|https?:\/\/|\/\/|#|mailto:|tel:|javascript:)((?:(?!\2).)*)\2/gi,
    (_match, attr, q, rawPath) => {
      try {
        const resolved = new URL(rawPath, finalPageUrl).href
        const signed = urlMap.get(resolved)
        if (signed) return `${attr}=${q}${signed}${q}`
      } catch {}
      return `${attr}=${q}${pageOrigin}/${String(rawPath).replace(/^\//, '')}${q}`
    }
  )

  nextHtml = nextHtml.replace(
    /srcset=(["'])(.*?)\1/gi,
    (_match, q, srcsetValue: string) => {
      const rewritten = srcsetValue
        .split(',')
        .map((candidate: string) => {
          const trimmed = candidate.trim()
          if (!trimmed) return trimmed
          const [rawUrl, descriptor] = trimmed.split(/\s+/, 2)
          let nextUrl = rawUrl
          try {
            const resolved = new URL(rawUrl, finalPageUrl).href
            nextUrl = urlMap.get(resolved) || resolved
          } catch {}
          return descriptor ? `${nextUrl} ${descriptor}` : nextUrl
        })
        .join(', ')
      return `srcset=${q}${rewritten}${q}`
    }
  )

  nextHtml = nextHtml.replace(
    /url\(\s*(['"]?)(?!data:|https?:\/\/|\/\/)([^'")]+)\1\s*\)/gi,
    (match, q, rawPath) => {
      try {
        const resolved = new URL(rawPath, finalPageUrl).href
        const signed = urlMap.get(resolved)
        if (signed) return `url(${q}${signed}${q})`
      } catch {}
      return match
    }
  )

  return nextHtml
}

async function claimJob(): Promise<any | null> {
  if (!HAS_SUPABASE) {
    return claimQueuedJob(WORKER_ID)
  }

  const { data, error } = await supabaseAdmin
    .from('crawl_runs')
    .update({ status: 'claimed', worker_id: WORKER_ID, started_at: new Date().toISOString() })
    .eq('status', 'queued')
    .order('queued_at', { ascending: true })
    .limit(1)
    .select('*, source_sites(*)')
    .single()
  if (error || !data) return null
  return data
}

async function failJob(jobId: string, code: string, message: string) {
  if (!HAS_SUPABASE) {
    await failCrawlRun(jobId, code, message)
    return
  }

  await supabaseAdmin
    .from('crawl_runs')
    .update({ status: 'failed', error_code: code, error_message: message, finished_at: new Date().toISOString() })
    .eq('id', jobId)
}

async function setCrawlRunStatus(jobId: string, patch: Record<string, any>) {
  if (!HAS_SUPABASE) {
    await updateCrawlRun(jobId, patch)
    return
  }

  await supabaseAdmin.from('crawl_runs').update(patch).eq('id', jobId)
}

async function createPageRecord(record: Record<string, any>) {
  if (!HAS_SUPABASE) {
    return createSourcePage(record as any)
  }

  const { data } = await supabaseAdmin
    .from('source_pages')
    .insert(record)
    .select()
    .single()
  return data
}

async function storePageAssets(records: Record<string, any>[]) {
  if (!records.length) return

  if (!HAS_SUPABASE) {
    await insertPageAssets(records)
    return
  }

  await supabaseAdmin.from('page_assets').insert(records)
}

async function createSectionRecord(record: Record<string, any>) {
  if (!HAS_SUPABASE) {
    return createSourceSection(record as any)
  }

  const { data, error } = await supabaseAdmin
    .from('source_sections')
    .insert(record)
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(error?.message || 'Failed to insert source_section')
  }

  return data
}

async function createSnapshotRecord(record: Record<string, any>) {
  if (!HAS_SUPABASE) {
    return createSectionDomSnapshot(record as any)
  }

  const { data, error } = await supabaseAdmin
    .from('section_dom_snapshots')
    .insert(record)
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(error?.message || 'Failed to insert DOM snapshot')
  }

  return data
}

async function storeSectionNodes(records: Record<string, any>[]) {
  if (!records.length) return

  if (!HAS_SUPABASE) {
    await insertSectionNodes(records as any)
    return
  }

  await supabaseAdmin.from('section_nodes').insert(records)
}

async function findVariantRecord(variantKey: string) {
  if (!HAS_SUPABASE) {
    return findBlockVariantByKey(variantKey)
  }

  const { data } = await supabaseAdmin
    .from('block_variants')
    .select('id')
    .eq('variant_key', variantKey)
    .single()

  return data
}

async function createBlockInstanceRecord(record: Record<string, any>) {
  if (!HAS_SUPABASE) {
    await insertBlockInstance(record)
    return
  }

  await supabaseAdmin.from('block_instances').insert(record)
}

async function markSiteAnalyzed(siteId: string) {
  const patch = {
    status: 'analyzed',
    last_crawled_at: new Date().toISOString()
  }

  if (!HAS_SUPABASE) {
    await updateSourceSite(siteId, patch)
    return
  }

  await supabaseAdmin.from('source_sites').update(patch).eq('id', siteId)
}

async function processJob(job: any) {
  const site = job.source_sites
  const url = site.homepage_url
  console.log(`[${WORKER_ID}] Processing: ${url}`)

  await setCrawlRunStatus(job.id, { status: 'rendering' })

  const browser = await launchBrowser()

  try {
    const page = await browser.newPage()

    // ========== Phase 1: Complete Site Download ==========
    console.log(`[${WORKER_ID}] Phase 1: Downloading site...`)
    const dl = await downloadSite(page, url, site.id, job.id)
    console.log(`[${WORKER_ID}] Downloaded: ${dl.title} | ${dl.cssFiles.length} CSS, ${dl.imageFiles.length} images, ${dl.fontFiles.length} fonts`)

    // ========== Phase 2: Store page-level data ==========
    await setCrawlRunStatus(job.id, { status: 'parsed' })

    // Upload rewritten HTML
    const finalHtmlPath = `${site.id}/${job.id}/final.html`
    await uploadBuffer(STORAGE_BUCKETS.RAW_HTML, finalHtmlPath, dl.finalHtml, 'text/html')

    // Full page screenshot (QA)
    let pageScreenshotPath: string | undefined
    try {
      const fullScreenshot = await page.screenshot({ fullPage: true }) as Buffer
      pageScreenshotPath = `${site.id}/${job.id}/fullpage.png`
      await uploadBuffer(STORAGE_BUCKETS.PAGE_SCREENSHOTS, pageScreenshotPath, fullScreenshot, 'image/png')
    } catch (ssErr: any) {
      console.warn(`[${WORKER_ID}] Page screenshot failed: ${ssErr.message}`)
    }

    // CSS bundle path (already uploaded by downloadSite)
    const cssBundlePath = `${site.id}/${job.id}/bundle.css`

    // Asset list
    const requestLog = JSON.stringify(dl.allAssets, null, 2)
    const requestLogPath = `${site.id}/${job.id}/assets.json`
    await uploadBuffer(STORAGE_BUCKETS.RAW_HTML, requestLogPath, requestLog, 'application/json')

    // Create source_page
    const sourcePage = await createPageRecord({
      crawl_run_id: job.id,
      site_id: site.id,
      url: page.url(),
      path: new URL(page.url()).pathname,
      page_type: 'home',
      title: dl.title,
      screenshot_storage_path: pageScreenshotPath,
      final_html_path: finalHtmlPath,
      request_log_path: requestLogPath,
      css_bundle_path: cssBundlePath
    })

    if (!sourcePage) throw new Error('Failed to create source_page')

    // Store page assets
    const assetRecords = dl.allAssets.slice(0, 200).map(a => ({
      page_id: sourcePage.id,
      asset_type: a.type,
      url: a.originalUrl,
      storage_path: a.storagePath,
      content_type: '',
      size_bytes: a.size,
      status_code: 200
    }))
    await storePageAssets(assetRecords)

    // ========== Phase 3: Section Detection ==========
    await setCrawlRunStatus(job.id, { status: 'normalizing' })

    const sections = await detectSections(page)
    console.log(`[${WORKER_ID}] Detected ${sections.length} sections`)

    // Build URL rewrite map for section HTML
    const urlMap = new Map<string, string>()
    for (const asset of dl.allAssets) {
      urlMap.set(asset.originalUrl, asset.signedUrl)
    }
    const sortedEntries = [...urlMap.entries()].sort((a, b) => b[0].length - a[0].length)

    // ========== Phase 4: Classify + Store each section ==========
    let sectionCount = 0

    for (const section of sections) {
      console.log(`[${WORKER_ID}] Section ${section.index}/${sections.length}: ${section.tagName} (${Math.round(section.boundingBox.height)}px)`)

      // Classify
      const rawForClassifier: RawSection = {
        tagName: section.tagName,
        outerHTML: section.outerHTML,
        textContent: section.textContent,
        boundingBox: section.boundingBox,
        computedStyles: section.computedStyles,
        hasImages: section.features.imageCount > 0,
        hasCTA: section.features.buttonCount > 0,
        hasForm: section.features.formCount > 0,
        headingCount: section.features.headingCount,
        linkCount: section.features.linkCount,
        cardCount: section.features.cardCount,
        childCount: section.features.childCount,
        classNames: section.classTokens.join(' '),
        id: section.idTokens[0] || ''
      }
      const classification = classifySection(rawForClassifier, section.index, sections.length)
      const canonical = canonicalizeSection(section, classification.type)
      const finalPageUrl = page.url()

      // Rewrite URLs in section HTML
      const sectionHtml = rewriteStoredHtml(section.outerHTML, finalPageUrl, dl.pageOrigin, sortedEntries, urlMap)
      // Upload rewritten section HTML
      const rawPath = `${site.id}/${job.id}/raw_${section.index}.html`
      await uploadBuffer(STORAGE_BUCKETS.RAW_HTML, rawPath, sectionHtml, 'text/html')

      const previewHtml = rewriteStoredHtml(section.previewHTML, finalPageUrl, dl.pageOrigin, sortedEntries, urlMap)
      const previewPath = `${site.id}/${job.id}/preview_${section.index}.html`
      await uploadBuffer(STORAGE_BUCKETS.SANITIZED_HTML, previewPath, previewHtml, 'text/html')

      // QA screenshot - non-fatal
      let thumbnailPath: string | undefined
      try {
        const screenshotBuf = await screenshotSection(page, section.boundingBox)
        if (screenshotBuf) {
          thumbnailPath = `${site.id}/${job.id}/section_${section.index}.png`
          await uploadBuffer(STORAGE_BUCKETS.SECTION_THUMBNAILS, thumbnailPath, screenshotBuf, 'image/png')
        }
      } catch (thumbErr: any) {
        console.warn(`[${WORKER_ID}] Thumbnail failed for section ${section.index}: ${thumbErr.message}`)
      }

      // Style summary + layout signature
      const styleSummary = extractStyleSummary(section)
      const layoutSig = generateLayoutSignature(section)

      // Store source_section
      const sectionRow = await createSectionRecord({
        page_id: sourcePage.id,
        site_id: site.id,
        order_index: section.index,
        dom_path: section.domPath,
        tag_name: section.tagName,
        bbox_json: section.boundingBox,
        raw_html_storage_path: rawPath,
        sanitized_html_storage_path: previewPath,
        thumbnail_storage_path: thumbnailPath,
        block_family: classification.type,
        block_variant: canonical?.variant,
        classifier_type: 'heuristic',
        classifier_confidence: classification.confidence,
        features_jsonb: section.features,
        text_summary: section.textContent.slice(0, 500),
        layout_signature: layoutSig,
        image_count: section.features.imageCount,
        button_count: section.features.buttonCount,
        repeated_child_pattern: section.features.repeatedChildPattern,
        class_tokens: section.classTokens,
        id_tokens: section.idTokens,
        computed_style_summary: styleSummary
      })

      try {
        const snapshot = await parseSectionDOM(page, section, section.index)
        if (snapshot.resolvedHtml && snapshot.nodes.length > 0) {
          const resolvedHtml = rewriteStoredHtml(snapshot.resolvedHtml, finalPageUrl, dl.pageOrigin, sortedEntries, urlMap)
          const resolvedPath = `${site.id}/${job.id}/resolved_${section.index}.html`
          const domJsonPath = `${site.id}/${job.id}/dom_${section.index}.json`

          await uploadBuffer(STORAGE_BUCKETS.SANITIZED_HTML, resolvedPath, resolvedHtml, 'text/html')
          await uploadBuffer(STORAGE_BUCKETS.SANITIZED_HTML, domJsonPath, JSON.stringify(snapshot.nodes), 'application/json')

          const snapshotRow = await createSnapshotRecord({
            section_id: sectionRow.id,
            snapshot_type: 'resolved',
            html_storage_path: resolvedPath,
            dom_json_path: domJsonPath,
            node_count: snapshot.nodeCount,
            css_strategy: 'resolved_inline'
          })

          const nodeRecords = snapshot.nodes.slice(0, 500).map(node => ({
            snapshot_id: snapshotRow.id,
            stable_key: node.stableKey,
            node_type: node.nodeType,
            tag_name: node.tagName,
            order_index: node.orderIndex,
            text_content: node.textContent,
            attrs_jsonb: node.attrs,
            bbox_json: node.bbox,
            computed_style_jsonb: node.computedStyle,
            editable: node.editable,
            selector_path: node.selectorPath
          }))

          await storeSectionNodes(nodeRecords)
        }
      } catch (snapshotErr: any) {
        console.warn(`[${WORKER_ID}] DOM snapshot failed for section ${section.index}: ${snapshotErr.message}`)
      }

      // Store canonical block_instance
      if (canonical) {
        const variantRow = await findVariantRecord(canonical.variant)

        if (variantRow) {
          await createBlockInstanceRecord({
            source_section_id: sectionRow.id,
            block_variant_id: variantRow.id,
            slot_values_jsonb: canonical.slots,
            token_values_jsonb: canonical.tokens,
            quality_score: canonical.qualityScore,
            family_key: canonical.family,
            variant_key: canonical.variant,
            provenance_jsonb: {
              pageId: sourcePage.id,
              sectionId: sectionRow.id,
              sourceUrl: page.url(),
              domPath: section.domPath
            }
          })
        }
      }

      sectionCount++
    }

    // ========== Phase 5: Mark complete ==========
    await setCrawlRunStatus(job.id, {
      status: 'done',
      page_count: 1,
      section_count: sectionCount,
      finished_at: new Date().toISOString()
    })

    await markSiteAnalyzed(site.id)

    console.log(`[${WORKER_ID}] Done: ${url} → ${sectionCount} sections, ${dl.allAssets.length} assets`)

  } catch (err: any) {
    console.error(`[${WORKER_ID}] Error:`, err.message)
    await failJob(job.id, 'PROCESSING_ERROR', err.message)
  } finally {
    await browser.close()
  }
}

async function pollLoop() {
  console.log(`[${WORKER_ID}] Worker v3 started, polling every ${POLL_INTERVAL}ms`)

  while (true) {
    try {
      const job = await claimJob()
      if (job) await processJob(job)
    } catch (err: any) {
      console.error(`[${WORKER_ID}] Poll error:`, err.message)
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }
}

pollLoop()
