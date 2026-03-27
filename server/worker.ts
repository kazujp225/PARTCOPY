/**
 * Extract Worker v3 - Complete Site Download + Multi-Page Crawling
 *
 * Pipeline:
 * 1. downloadSite: HTML/CSS/画像/フォントを全て直接ダウンロード → URL書き換え
 * 2. Section detection (Puppeteer page.evaluate)
 * 3. Classify + Canonicalize + Store each section (with rewritten URLs)
 * 4. DOM snapshot for editing
 * 5. Collect same-domain links → crawl sub-pages (up to max_pages)
 */
import {
  claimQueuedJob,
  cleanupCrawlRunSections,
  cleanupOldData,
  createSectionDomSnapshot,
  createSourcePage,
  createSourceSection,
  failCrawlRun,
  findBlockVariantByKey,
  insertBlockInstance,
  insertPageAssets,
  insertSectionNodes,
  readStoredText,
  updateCrawlRun,
  updateSourceSection,
  updateSourceSite,
  writeStoredFile
} from './local-store.js'
// TSX変換はZIPエクスポート時にオンデマンド実行（server/index.ts）
import { HAS_SUPABASE, supabaseAdmin } from './supabase.js'
import { STORAGE_BUCKETS } from './storage-config.js'
import { launchBrowser, collectPageLinks } from './capture-runner.js'
import { downloadSite } from './site-downloader.js'
import { detectSections, screenshotSection } from './section-detector.js'
import { extractStyleSummary, generateLayoutSignature } from './style-extractor.js'
import { classifySection, type RawSection } from './classifier.js'
import { canonicalizeSection } from './canonicalizer.js'
import { parseSectionDOM } from './dom-parser.js'
import { logger } from './logger.js'
import { startAutoCrawler } from './auto-crawler.js'

const WORKER_ID = `worker-${process.pid}`
const POLL_INTERVAL = 3000
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_S = 5
const DEFAULT_MAX_PAGES = 5
const DATA_RETENTION_DAYS = Number(process.env.DATA_RETENTION_DAYS) || 30
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const SITE_TIMEOUT_MS = 180000 // 180s overall timeout for download + section detection
const DOWNLOAD_TIMEOUT_MS = 150000 // 150s timeout for site download (images+fonts take time)
const DETECT_TIMEOUT_MS = 30000 // 30s timeout for section detection

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<{ result: T; timedOut: false } | { result: undefined; timedOut: true }> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<{ result: undefined; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ result: undefined, timedOut: true }), ms)
  })
  return Promise.race([
    promise.then((result) => ({ result, timedOut: false as const })).finally(() => clearTimeout(timer)),
    timeout
  ])
}

let shuttingDown = false
process.on('SIGTERM', () => { shuttingDown = true; logger.info('Shutdown signal received', { signal: 'SIGTERM', workerId: WORKER_ID }); setTimeout(() => process.exit(0), 3000).unref() })
process.on('SIGINT', () => { shuttingDown = true; logger.info('Shutdown signal received', { signal: 'SIGINT', workerId: WORKER_ID }); setTimeout(() => process.exit(0), 3000).unref() })

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
      logger.warn('Upload retry', { attempt: attempt + 1, bucket, path, error: error.message })
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
      continue
    }
    throw new Error(`Storage upload failed (${bucket}/${path}): ${error.message}`)
  }
  return path
}

/**
 * セクションHTML内のURLをローカルアセットパスに書き換える。
 *
 * 1. 絶対URL（urlMap のキー）を直接置換
 * 2. 相対URL / ルート相対URLをページURLで解決し、urlMap にあれば置換
 */
function rewriteStoredHtml(
  html: string,
  finalPageUrl: string,
  _pageOrigin: string,
  sortedEntries: Array<[string, string]>,
  urlMap: Map<string, string>
) {
  let result = html

  // Step 1: 絶対URL の直接置換（長い順）
  for (const [originalUrl, localPath] of sortedEntries) {
    result = result.split(originalUrl).join(localPath)
  }

  // Step 2: 相対URL → 絶対URL → urlMap で置換
  result = result.replace(
    /(src|href|srcset|poster|action)=(["'])(?!data:|https?:\/\/|\/\/|#|mailto:|tel:|javascript:|\/?assets\/)((?:(?!\2).)*)\2/gi,
    (match, attr, q, rawPath) => {
      // srcset は複数URL がカンマ区切りのため個別に解決
      if (attr.toLowerCase() === 'srcset') {
        const rewritten = rawPath.split(',').map((segment: string) => {
          const parts = segment.trim().split(/\s+/)
          const url = parts[0]
          try {
            const resolved = new URL(url, finalPageUrl).href
            const local = urlMap.get(resolved)
            if (local) { parts[0] = local }
          } catch {}
          return parts.join(' ')
        }).join(', ')
        return `${attr}=${q}${rewritten}${q}`
      }

      try {
        const resolved = new URL(rawPath, finalPageUrl).href
        const local = urlMap.get(resolved)
        if (local) return `${attr}=${q}${local}${q}`
      } catch {}
      return match
    }
  )

  // Step 3: inline style の background-image url() も解決
  result = result.replace(
    /url\(\s*(['"]?)(?!data:|https?:\/\/|\/\/|\/?assets\/)((?:(?!\1\)).)*)\1\s*\)/gi,
    (match, q, rawPath) => {
      try {
        const resolved = new URL(rawPath, finalPageUrl).href
        const local = urlMap.get(resolved)
        if (local) return `url(${q}${local}${q})`
      } catch {}
      return match
    }
  )

  return result
}

async function claimJob(): Promise<any | null> {
  if (!HAS_SUPABASE) {
    return claimQueuedJob(WORKER_ID)
  }

  // Step 1: Find the oldest queued job
  const { data: candidate } = await supabaseAdmin
    .from('crawl_runs')
    .select('id')
    .eq('status', 'queued')
    .or(`run_after.is.null,run_after.lte.${new Date().toISOString()}`)
    .order('queued_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!candidate) return null

  // Step 2: Claim it (atomic update with status check)
  const { data, error } = await supabaseAdmin
    .from('crawl_runs')
    .update({ status: 'claimed', worker_id: WORKER_ID, started_at: new Date().toISOString() })
    .eq('id', candidate.id)
    .eq('status', 'queued')
    .select('*, source_sites(*)')
    .maybeSingle()

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

/**
 * 単一ページをダウンロード → セクション検出 → 分類 → 保存するパイプライン。
 * processJob から呼び出される。
 *
 * @returns セクション数と、ページ上で検出された同一ドメインリンクのリスト
 */
interface PagePipelineResult {
  sectionCount: number
  collectedLinks: string[]
  pageUrl: string
}

async function processOnePage(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  targetUrl: string,
  job: any,
  site: any,
  pageType: string,
  pageLabel: string
): Promise<PagePipelineResult> {
  const page = await browser.newPage()

  try {
    // ========== Phase 1: Complete Site Download ==========
    logger.info(`${pageLabel} Phase 1: Downloading`, { jobId: job.id, url: targetUrl })
    await setCrawlRunStatus(job.id, { status: 'rendering', status_detail: `${pageLabel}: ダウンロード中` })

    const dlResult = await withTimeout(downloadSite(page, targetUrl, site.id, job.id), DOWNLOAD_TIMEOUT_MS, 'downloadSite')
    let dl: Awaited<ReturnType<typeof downloadSite>>
    if (dlResult.timedOut) {
      logger.warn(`${pageLabel} Phase 1 timeout: downloadSite exceeded timeout, using partial content`, { jobId: job.id, url: targetUrl })
      const partialHtml = await page.content().catch(() => '<html><body></body></html>')
      const pageTitle = await page.title().catch(() => '')
      dl = {
        finalHtml: partialHtml,
        title: pageTitle,
        cssFiles: [],
        imageFiles: [],
        fontFiles: [],
        allAssets: [],
        pageOrigin: new URL(targetUrl).origin
      } as any
    } else {
      dl = dlResult.result
    }
    logger.info(`${pageLabel} Download complete`, { jobId: job.id, title: dl.title, cssCount: dl.cssFiles.length, imageCount: dl.imageFiles.length, fontCount: dl.fontFiles.length })

    // 認証チェック: レスポンスがログインページにリダイレクトされた場合スキップ
    const finalUrl = page.url()
    const AUTH_REDIRECT_PATTERNS = /\/(login|signin|sign-in|auth|oauth|sso|wp-login)/i
    if (AUTH_REDIRECT_PATTERNS.test(new URL(finalUrl).pathname) && !AUTH_REDIRECT_PATTERNS.test(new URL(targetUrl).pathname)) {
      logger.info(`${pageLabel} Skipped: redirected to auth page`, { jobId: job.id, targetUrl, redirectedTo: finalUrl })
      return { sectionCount: 0, collectedLinks: [], pageUrl: targetUrl }
    }

    // ========== Phase 2: Store page-level data ==========
    await setCrawlRunStatus(job.id, { status: 'parsed', status_detail: `${pageLabel}: ダウンロード完了` })

    // 一意のページ接尾辞（サブページ用にパスをハッシュ化）
    const pageSlug = pageType === 'home' ? '' : `_${Buffer.from(new URL(targetUrl).pathname).toString('base64url').slice(0, 16)}`
    const finalHtmlPath = `${site.id}/${job.id}/final${pageSlug}.html`
    await uploadBuffer(STORAGE_BUCKETS.RAW_HTML, finalHtmlPath, dl.finalHtml, 'text/html')

    let pageScreenshotPath: string | undefined
    try {
      const fullScreenshot = await page.screenshot({ fullPage: true }) as Buffer
      pageScreenshotPath = `${site.id}/${job.id}/fullpage${pageSlug}.png`
      await uploadBuffer(STORAGE_BUCKETS.PAGE_SCREENSHOTS, pageScreenshotPath, fullScreenshot, 'image/png')
    } catch (ssErr: any) {
      logger.warn(`${pageLabel} Page screenshot failed`, { jobId: job.id, error: ssErr.message })
    }

    const cssBundlePath = `${site.id}/${job.id}/bundle.css`

    const requestLog = JSON.stringify(dl.allAssets, null, 2)
    const requestLogPath = `${site.id}/${job.id}/assets${pageSlug}.json`
    await uploadBuffer(STORAGE_BUCKETS.RAW_HTML, requestLogPath, requestLog, 'application/json')

    const sourcePage = await createPageRecord({
      crawl_run_id: job.id,
      site_id: site.id,
      url: page.url(),
      path: new URL(page.url()).pathname,
      page_type: pageType,
      title: dl.title,
      screenshot_storage_path: pageScreenshotPath,
      final_html_path: finalHtmlPath,
      request_log_path: requestLogPath,
      css_bundle_path: cssBundlePath
    })

    if (!sourcePage) throw new Error('Failed to create source_page')

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
    await setCrawlRunStatus(job.id, { status: 'normalizing', status_detail: `${pageLabel}: セクション検出中` })

    const detectResult = await withTimeout(detectSections(page), DETECT_TIMEOUT_MS, 'detectSections')
    let sections: Awaited<ReturnType<typeof detectSections>>
    if (detectResult.timedOut) {
      logger.warn(`${pageLabel} Phase 3 timeout: detectSections exceeded timeout`, { jobId: job.id })
      sections = []
    } else {
      sections = detectResult.result
    }
    logger.info(`${pageLabel} Sections detected`, { jobId: job.id, sectionCount: sections.length })

    await setCrawlRunStatus(job.id, { status: 'normalizing', status_detail: `${pageLabel}: ${sections.length}セクション検出` })

    // Build URL rewrite map for section HTML
    const urlMap = new Map<string, string>()
    for (const asset of dl.allAssets) {
      urlMap.set(asset.originalUrl, asset.signedUrl)
    }
    const sortedEntries = [...urlMap.entries()].sort((a, b) => b[0].length - a[0].length)

    // ========== Phase 4: Classify + Store each section ==========
    let sectionCount = 0

    for (const section of sections) {
      await setCrawlRunStatus(job.id, { status_detail: `${pageLabel}: セクション ${section.index + 1}/${sections.length} 処理中` })
      logger.debug('Processing section', { jobId: job.id, pageLabel, sectionIndex: section.index, total: sections.length, tagName: section.tagName, height: Math.round(section.boundingBox.height) })

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

      const sectionHtml = rewriteStoredHtml(section.outerHTML, finalPageUrl, dl.pageOrigin, sortedEntries, urlMap)
      const rawPath = `${site.id}/${job.id}/raw${pageSlug}_${section.index}.html`
      await uploadBuffer(STORAGE_BUCKETS.RAW_HTML, rawPath, sectionHtml, 'text/html')

      const previewHtml = rewriteStoredHtml(section.previewHTML, finalPageUrl, dl.pageOrigin, sortedEntries, urlMap)
      const previewPath = `${site.id}/${job.id}/preview${pageSlug}_${section.index}.html`
      await uploadBuffer(STORAGE_BUCKETS.SANITIZED_HTML, previewPath, previewHtml, 'text/html')

      let thumbnailPath: string | undefined
      try {
        const screenshotBuf = await screenshotSection(page, section.boundingBox)
        if (screenshotBuf) {
          thumbnailPath = `${site.id}/${job.id}/section${pageSlug}_${section.index}.png`
          await uploadBuffer(STORAGE_BUCKETS.SECTION_THUMBNAILS, thumbnailPath, screenshotBuf, 'image/png')
        }
      } catch (thumbErr: any) {
        logger.warn('Thumbnail failed', { jobId: job.id, pageLabel, sectionIndex: section.index, error: thumbErr.message })
      }

      const styleSummary = extractStyleSummary(section)
      const layoutSig = generateLayoutSignature(section)

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
          const resolvedPath = `${site.id}/${job.id}/resolved${pageSlug}_${section.index}.html`
          const domJsonPath = `${site.id}/${job.id}/dom${pageSlug}_${section.index}.json`

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
        logger.warn('DOM snapshot failed', { jobId: job.id, pageLabel, sectionIndex: section.index, error: snapshotErr.message })
      }

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

    // Collect same-domain links before closing the page
    let collectedLinks: string[] = []
    try {
      collectedLinks = await collectPageLinks(page, targetUrl)
      logger.info(`${pageLabel} Collected links`, { jobId: job.id, linkCount: collectedLinks.length })
    } catch (linkErr: any) {
      logger.warn(`${pageLabel} Link collection failed`, { jobId: job.id, error: linkErr.message })
    }

    return { sectionCount, collectedLinks, pageUrl: page.url() }
  } finally {
    await page.close().catch(() => {})
  }
}

/**
 * サブページのURLにHTTPアクセスして、401/403 またはログインリダイレクトを検出する。
 * Puppeteer を使わず fetch でチェックするため高速。
 */
async function isPageAccessible(targetUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    const response = await fetch(targetUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    })

    clearTimeout(timeoutId)

    // 401/403 はスキップ
    if (response.status === 401 || response.status === 403) {
      return false
    }

    // リダイレクト先が認証ページの場合スキップ
    const AUTH_PATTERNS = /\/(login|signin|sign-in|auth|oauth|sso|wp-login)/i
    const redirectedUrl = response.url
    if (AUTH_PATTERNS.test(new URL(redirectedUrl).pathname) && !AUTH_PATTERNS.test(new URL(targetUrl).pathname)) {
      return false
    }

    return response.ok || response.status === 304
  } catch {
    // ネットワークエラー等はスキップ
    return false
  }
}

async function processJob(job: any) {
  const site = job.source_sites
  const url = site.homepage_url
  const maxPages = Number(job.max_pages) || DEFAULT_MAX_PAGES
  logger.info('Job started', { jobId: job.id, siteId: site.id, url, maxPages, workerId: WORKER_ID })

  await setCrawlRunStatus(job.id, { status: 'rendering' })

  const browser = await launchBrowser()

  try {
    // ========== メインページ処理 ==========
    const mainResult = await processOnePage(browser, url, job, site, 'home', 'ページ 1/1')

    let totalSectionCount = mainResult.sectionCount
    let totalPageCount = 1
    const crawledUrls = new Set<string>()
    crawledUrls.add(url)
    // finalUrl（リダイレクト後）も記録
    crawledUrls.add(mainResult.pageUrl)

    // ========== サブページクロール ==========
    if (maxPages > 1 && mainResult.collectedLinks.length > 0) {
      // 最大 maxPages - 1 ページ（メインページ分を引く）
      const subPageLimit = maxPages - 1
      const candidateLinks = mainResult.collectedLinks.filter(link => !crawledUrls.has(link))

      logger.info('Starting sub-page crawl', {
        jobId: job.id,
        candidates: candidateLinks.length,
        limit: subPageLimit
      })

      let subPagesCrawled = 0

      for (const subUrl of candidateLinks) {
        if (subPagesCrawled >= subPageLimit) break
        if (shuttingDown) break

        // 既にクロール済みのURLはスキップ
        if (crawledUrls.has(subUrl)) continue
        crawledUrls.add(subUrl)

        const subPageLabel = `ページ ${totalPageCount + 1}/${maxPages}`

        // アクセシビリティ事前チェック（HEAD リクエスト）
        const accessible = await isPageAccessible(subUrl)
        if (!accessible) {
          logger.info(`${subPageLabel} Skipped: not accessible`, { jobId: job.id, url: subUrl })
          continue
        }

        try {
          await setCrawlRunStatus(job.id, {
            status: 'rendering',
            status_detail: `${subPageLabel}: ${new URL(subUrl).pathname} クロール中`
          })

          const subResult = await processOnePage(browser, subUrl, job, site, 'subpage', subPageLabel)

          // リダイレクト先も記録
          crawledUrls.add(subResult.pageUrl)

          totalSectionCount += subResult.sectionCount
          totalPageCount++
          subPagesCrawled++

          // サブページから得たリンクも候補に追加（既存候補の後ろに）
          for (const newLink of subResult.collectedLinks) {
            if (!crawledUrls.has(newLink) && !candidateLinks.includes(newLink)) {
              candidateLinks.push(newLink)
            }
          }

          logger.info(`${subPageLabel} completed`, {
            jobId: job.id,
            url: subUrl,
            sections: subResult.sectionCount,
            newLinks: subResult.collectedLinks.length
          })

          // ページ間に短い遅延（サーバー負荷軽減）
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000))

        } catch (subErr: any) {
          logger.warn(`${subPageLabel} failed, continuing`, {
            jobId: job.id,
            url: subUrl,
            error: subErr.message
          })
          // サブページの失敗はジョブ全体を失敗させない
          continue
        }
      }
    }

    // ========== Auto-cleanup duplicates & garbage ==========
    const cleanup = await cleanupCrawlRunSections(job.id)
    if (cleanup.duplicates + cleanup.garbage + cleanup.oversized > 0) {
      totalSectionCount -= (cleanup.duplicates + cleanup.garbage + cleanup.oversized)
      logger.info('Auto-cleanup completed', {
        jobId: job.id,
        duplicates: cleanup.duplicates,
        garbage: cleanup.garbage,
        oversized: cleanup.oversized
      })
    }

    // ========== Mark complete ==========
    await setCrawlRunStatus(job.id, {
      status: 'done',
      page_count: totalPageCount,
      section_count: Math.max(0, totalSectionCount),
      finished_at: new Date().toISOString()
    })

    await markSiteAnalyzed(site.id)

    logger.info('Job completed', {
      jobId: job.id,
      siteId: site.id,
      url,
      pageCount: totalPageCount,
      sectionCount: totalSectionCount
    })

  } catch (err: any) {
    const retryCount = Number(job.retry_count) || 0
    if (retryCount < MAX_RETRIES) {
      const nextRetry = retryCount + 1
      const delaySec = RETRY_BASE_DELAY_S * Math.pow(3, retryCount) // 5s, 15s, 45s
      const runAfter = new Date(Date.now() + delaySec * 1000).toISOString()
      logger.warn('Job failed, scheduling retry', { jobId: job.id, attempt: nextRetry, maxRetries: MAX_RETRIES, delaySec, error: err.message })
      await setCrawlRunStatus(job.id, {
        status: 'queued',
        retry_count: nextRetry,
        run_after: runAfter,
        worker_id: null,
        started_at: null,
        error_message: err.message
      })
    } else {
      logger.error('Job permanently failed', { jobId: job.id, retries: MAX_RETRIES, error: err.message })
      await failJob(job.id, 'PROCESSING_ERROR', `Failed after ${MAX_RETRIES} retries: ${err.message}`)
    }
  } finally {
    await browser.close().catch((closeErr: any) => {
      logger.warn('Browser close failed (may already be closed)', { error: closeErr.message })
    })
  }
}

async function runCleanup() {
  if (HAS_SUPABASE) {
    // TODO: Implement Supabase cleanup via RPC or scheduled SQL function
    return
  }

  try {
    const result = await cleanupOldData(DATA_RETENTION_DAYS)
    if (result.deletedCrawlRuns > 0) {
      logger.info('Data cleanup completed', { retentionDays: DATA_RETENTION_DAYS, ...result })
    } else {
      logger.debug('Data cleanup: nothing to remove', { retentionDays: DATA_RETENTION_DAYS })
    }
  } catch (err: any) {
    logger.error('Data cleanup failed', { error: err.message })
  }
}

async function pollLoop() {
  logger.info('Worker started', { workerId: WORKER_ID, pollIntervalMs: POLL_INTERVAL })

  // Run cleanup once at startup
  await runCleanup()

  // Schedule periodic cleanup every 24 hours
  const cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS)

  while (!shuttingDown) {
    try {
      const job = await claimJob()
      if (job) await processJob(job)
    } catch (err: any) {
      logger.error('Poll error', { workerId: WORKER_ID, error: err.message })
    }
    if (shuttingDown) break
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }

  clearInterval(cleanupTimer)
  logger.info('Worker shut down gracefully', { workerId: WORKER_ID })
  process.exit(0)
}

pollLoop()

// 常にauto-crawlerを起動（キューファイルがあれば処理、なければ待機）
startAutoCrawler()
