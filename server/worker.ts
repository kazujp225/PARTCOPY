/**
 * Extract Worker v3 - Complete Site Download
 *
 * Pipeline:
 * 1. downloadSite: HTML/CSS/画像/フォントを全て直接ダウンロード → URL書き換え
 * 2. Section detection (Puppeteer page.evaluate)
 * 3. Classify + Canonicalize + Store each section (with rewritten URLs)
 * 4. DOM snapshot for editing
 */
import { supabaseAdmin, STORAGE_BUCKETS } from './supabase.js'
import { launchBrowser } from './capture-runner.js'
import { downloadSite } from './site-downloader.js'
import { detectSections, screenshotSection } from './section-detector.js'
import { extractStyleSummary, generateLayoutSignature } from './style-extractor.js'
import { classifySection, type RawSection } from './classifier.js'
import { canonicalizeSection } from './canonicalizer.js'

const WORKER_ID = `worker-${process.pid}`
const POLL_INTERVAL = 3000

async function uploadBuffer(bucket: string, path: string, data: Buffer | string, contentType: string): Promise<string> {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
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

async function claimJob(): Promise<any | null> {
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
  await supabaseAdmin
    .from('crawl_runs')
    .update({ status: 'failed', error_code: code, error_message: message, finished_at: new Date().toISOString() })
    .eq('id', jobId)
}

async function processJob(job: any) {
  const site = job.source_sites
  const url = site.homepage_url
  console.log(`[${WORKER_ID}] Processing: ${url}`)

  await supabaseAdmin.from('crawl_runs').update({ status: 'rendering' }).eq('id', job.id)

  const browser = await launchBrowser()

  try {
    const page = await browser.newPage()

    // ========== Phase 1: Complete Site Download ==========
    console.log(`[${WORKER_ID}] Phase 1: Downloading site...`)
    const dl = await downloadSite(page, url, site.id, job.id)
    console.log(`[${WORKER_ID}] Downloaded: ${dl.title} | ${dl.cssFiles.length} CSS, ${dl.imageFiles.length} images, ${dl.fontFiles.length} fonts`)

    // ========== Phase 2: Store page-level data ==========
    await supabaseAdmin.from('crawl_runs').update({ status: 'parsed' }).eq('id', job.id)

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
    const { data: sourcePage } = await supabaseAdmin
      .from('source_pages')
      .insert({
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
      .select()
      .single()

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
    if (assetRecords.length > 0) {
      await supabaseAdmin.from('page_assets').insert(assetRecords)
    }

    // ========== Phase 3: Section Detection ==========
    await supabaseAdmin.from('crawl_runs').update({ status: 'normalizing' }).eq('id', job.id)

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

      // Rewrite URLs in section HTML
      let sectionHtml = section.outerHTML
      // まず絶対URLの直接置換
      for (const [originalUrl, signedUrl] of sortedEntries) {
        sectionHtml = sectionHtml.split(originalUrl).join(signedUrl)
      }
      // 相対/ルート相対URLをresolveしてurlMapで置換
      const finalPageUrl = page.url()
      sectionHtml = sectionHtml.replace(
        /(src|href|srcset|poster|action)=(["'])(?!data:|https?:\/\/|\/\/|#|mailto:|tel:|javascript:)((?:(?!\2).)*)\2/gi,
        (match, attr, q, rawPath) => {
          try {
            const resolved = new URL(rawPath, finalPageUrl).href
            const signed = urlMap.get(resolved)
            if (signed) return `${attr}=${q}${signed}${q}`
          } catch {}
          return `${attr}=${q}${dl.pageOrigin}/${rawPath.replace(/^\//, '')}${q}`
        }
      )
      // background-image url() in inline styles
      sectionHtml = sectionHtml.replace(
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

      // Upload rewritten section HTML
      const rawPath = `${site.id}/${job.id}/raw_${section.index}.html`
      await uploadBuffer(STORAGE_BUCKETS.RAW_HTML, rawPath, sectionHtml, 'text/html')

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
      await supabaseAdmin.from('source_sections').insert({
        page_id: sourcePage.id,
        site_id: site.id,
        order_index: section.index,
        dom_path: section.domPath,
        tag_name: section.tagName,
        bbox_json: section.boundingBox,
        raw_html_storage_path: rawPath,
        sanitized_html_storage_path: rawPath, // same: URLs already rewritten
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

      // Store canonical block_instance
      if (canonical) {
        const { data: sectionRow } = await supabaseAdmin
          .from('source_sections')
          .select('id')
          .eq('page_id', sourcePage.id)
          .eq('order_index', section.index)
          .single()

        if (sectionRow) {
          const { data: variantRow } = await supabaseAdmin
            .from('block_variants')
            .select('id')
            .eq('variant_key', canonical.variant)
            .single()

          if (variantRow) {
            await supabaseAdmin.from('block_instances').insert({
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
      }

      sectionCount++
    }

    // ========== Phase 5: Mark complete ==========
    await supabaseAdmin.from('crawl_runs').update({
      status: 'done',
      page_count: 1,
      section_count: sectionCount,
      finished_at: new Date().toISOString()
    }).eq('id', job.id)

    await supabaseAdmin.from('source_sites').update({
      status: 'analyzed',
      last_crawled_at: new Date().toISOString()
    }).eq('id', site.id)

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
