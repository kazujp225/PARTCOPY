/**
 * Crawl Worker - Separated from API server.
 * Polls for 'queued' crawl_runs, processes them, writes results to Supabase.
 *
 * Run: tsx server/worker.ts
 */
import puppeteer from 'puppeteer'
import { supabaseAdmin, STORAGE_BUCKETS } from './supabase.js'
import { classifySection, type RawSection } from './classifier.js'

const WORKER_ID = `worker-${process.pid}`
const POLL_INTERVAL = 3000

async function ensureBuckets() {
  for (const bucket of Object.values(STORAGE_BUCKETS)) {
    const { error } = await supabaseAdmin.storage.createBucket(bucket, { public: false })
    if (error && !error.message.includes('already exists')) {
      console.error(`Bucket create error (${bucket}):`, error.message)
    }
  }
}

async function uploadBuffer(bucket: string, path: string, data: Buffer | string, contentType: string): Promise<string> {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
  const { error } = await supabaseAdmin.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: true
  })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)
  return path
}

async function claimJob(): Promise<any | null> {
  // Atomically claim a queued job
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
  console.log(`[${WORKER_ID}] Processing: ${url} (job: ${job.id})`)

  // Update status to rendering
  await supabaseAdmin.from('crawl_runs').update({ status: 'rendering' }).eq('id', job.id)

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })

    // Trigger lazy-load
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await new Promise(r => setTimeout(r, 1500))
    await page.evaluate(() => window.scrollTo(0, 0))
    await new Promise(r => setTimeout(r, 500))

    // Full page screenshot
    const pageScreenshot = await page.screenshot({ fullPage: true }) as Buffer
    const pageScreenshotPath = `${site.id}/${job.id}/fullpage.png`
    await uploadBuffer(STORAGE_BUCKETS.PAGE_SCREENSHOTS, pageScreenshotPath, pageScreenshot, 'image/png')

    // Update status
    await supabaseAdmin.from('crawl_runs').update({ status: 'parsed' }).eq('id', job.id)

    // Create source_page
    const pageUrl = page.url()
    const pageTitle = await page.title()
    const { data: sourcePage } = await supabaseAdmin
      .from('source_pages')
      .insert({
        crawl_run_id: job.id,
        site_id: site.id,
        url: pageUrl,
        path: new URL(pageUrl).pathname,
        page_type: 'home',
        title: pageTitle,
        screenshot_storage_path: pageScreenshotPath
      })
      .select()
      .single()

    if (!sourcePage) throw new Error('Failed to create source_page')

    // Extract sections
    const sections: RawSection[] = await page.evaluate(() => {
      const results: any[] = []
      const candidates = new Set<Element>()

      document.querySelectorAll('header, nav, main, section, article, aside, footer').forEach(el => candidates.add(el))
      const body = document.body
      for (const child of Array.from(body.children)) {
        const tag = child.tagName.toLowerCase()
        if (['script', 'style', 'link', 'meta', 'noscript', 'br', 'hr'].includes(tag)) continue
        const rect = child.getBoundingClientRect()
        if (rect.height > 50 && rect.width > 200) {
          let dominated = false
          for (const c of candidates) {
            if (c.contains(child) && c !== child) { dominated = true; break }
          }
          if (!dominated) candidates.add(child)
        }
      }

      const candidateArr = Array.from(candidates)
      const filtered = candidateArr.filter(el => {
        const tag = el.tagName.toLowerCase()
        if (['nav', 'header', 'footer'].includes(tag)) return true
        const hasChildCandidate = candidateArr.some(other => other !== el && el.contains(other))
        if (hasChildCandidate) {
          const rect = el.getBoundingClientRect()
          if (rect.height > window.innerHeight * 1.5) return false
        }
        return true
      })

      for (const el of filtered) {
        const rect = el.getBoundingClientRect()
        if (rect.height < 30) continue

        const links = el.querySelectorAll('a')
        const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6')
        const images = el.querySelectorAll('img, svg, picture, video')
        const buttons = el.querySelectorAll('button, a[href], input[type="submit"], .btn, [class*="button"], [class*="btn"]')
        const forms = el.querySelectorAll('form')
        const cards = el.querySelectorAll('[class*="card"], [class*="item"], [class*="col-"], [class*="grid-"] > *')
        const cs = window.getComputedStyle(el)

        results.push({
          tagName: el.tagName,
          outerHTML: el.outerHTML,
          textContent: (el.textContent || '').slice(0, 2000),
          boundingBox: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          computedStyles: {
            backgroundColor: cs.backgroundColor,
            backgroundImage: cs.backgroundImage,
            fontSize: cs.fontSize,
            fontFamily: cs.fontFamily,
            padding: cs.padding,
            display: cs.display,
            position: cs.position
          },
          hasImages: images.length > 0,
          hasCTA: buttons.length > 0,
          hasForm: forms.length > 0,
          headingCount: headings.length,
          linkCount: links.length,
          cardCount: cards.length,
          childCount: el.children.length,
          classNames: el.className || '',
          id: el.id || ''
        })
      }
      return results
    })

    // Update to normalizing
    await supabaseAdmin.from('crawl_runs').update({ status: 'normalizing' }).eq('id', job.id)

    // Process each section: classify, screenshot, sanitize, store
    let sectionCount = 0
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]
      const classification = classifySection(section, i, sections.length)

      // Screenshot
      let thumbnailPath: string | undefined
      try {
        const elHandle = await page.evaluateHandle((idx: number) => {
          const cands = new Set<Element>()
          document.querySelectorAll('header, nav, main, section, article, aside, footer').forEach(el => cands.add(el))
          for (const child of Array.from(document.body.children)) {
            const tag = child.tagName.toLowerCase()
            if (['script', 'style', 'link', 'meta', 'noscript', 'br', 'hr'].includes(tag)) continue
            const rect = child.getBoundingClientRect()
            if (rect.height > 50 && rect.width > 200) {
              let dom = false
              for (const c of cands) { if (c.contains(child) && c !== child) { dom = true; break } }
              if (!dom) cands.add(child)
            }
          }
          const arr = Array.from(cands)
          const filt = arr.filter(el => {
            const tag = el.tagName.toLowerCase()
            if (['nav', 'header', 'footer'].includes(tag)) return true
            const has = arr.some(o => o !== el && el.contains(o))
            if (has && el.getBoundingClientRect().height > window.innerHeight * 1.5) return false
            return true
          }).filter(el => el.getBoundingClientRect().height >= 30)
          return filt[idx] || null
        }, i)

        const el = elHandle.asElement()
        if (el) {
          await el.scrollIntoView()
          await new Promise(r => setTimeout(r, 150))
          const buf = await el.screenshot() as Buffer
          thumbnailPath = `${site.id}/${job.id}/section_${i}.png`
          await uploadBuffer(STORAGE_BUCKETS.SECTION_THUMBNAILS, thumbnailPath, buf, 'image/png')
        }
      } catch { /* screenshot failed, continue */ }

      // Sanitize HTML: strip images, convert relative URLs
      const baseUrl = new URL(url)
      const origin = baseUrl.origin
      let sanitized = section.outerHTML
        .replace(/<img\b[^>]*>/gi, '<div class="pc-img-placeholder" style="background:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:80px;color:#94a3b8;font-size:13px;">IMAGE</div>')
        .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '<div class="pc-img-placeholder" style="background:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:80px;color:#94a3b8;font-size:13px;">IMAGE</div>')
        .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, '<div class="pc-img-placeholder" style="background:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:80px;color:#94a3b8;font-size:13px;">VIDEO</div>')
        .replace(/background-image\s*:\s*url\([^)]*\)\s*;?/gi, '')

      // Upload raw + sanitized HTML
      const rawPath = `${site.id}/${job.id}/raw_${i}.html`
      const sanitizedPath = `${site.id}/${job.id}/sanitized_${i}.html`
      await uploadBuffer(STORAGE_BUCKETS.RAW_HTML, rawPath, section.outerHTML, 'text/html')
      await uploadBuffer(STORAGE_BUCKETS.SANITIZED_HTML, sanitizedPath, sanitized, 'text/html')

      // Features for future ML
      const features = {
        hasImages: section.hasImages,
        hasCTA: section.hasCTA,
        hasForm: section.hasForm,
        headingCount: section.headingCount,
        linkCount: section.linkCount,
        cardCount: section.cardCount,
        childCount: section.childCount,
        height: section.boundingBox.height,
        width: section.boundingBox.width,
        positionRatio: i / Math.max(sections.length - 1, 1),
        textLength: section.textContent.length,
        fontSize: section.computedStyles.fontSize,
        display: section.computedStyles.display
      }

      // Insert source_section
      await supabaseAdmin.from('source_sections').insert({
        page_id: sourcePage.id,
        site_id: site.id,
        order_index: i,
        dom_path: `body > :nth-child(${i + 1})`,
        tag_name: section.tagName,
        bbox_json: section.boundingBox,
        raw_html_storage_path: rawPath,
        sanitized_html_storage_path: sanitizedPath,
        thumbnail_storage_path: thumbnailPath,
        block_family: classification.type,
        classifier_type: 'heuristic',
        classifier_confidence: classification.confidence,
        features_jsonb: features,
        text_summary: section.textContent.slice(0, 500)
      })

      sectionCount++
    }

    // Mark done
    await supabaseAdmin.from('crawl_runs').update({
      status: 'done',
      page_count: 1,
      section_count: sectionCount,
      finished_at: new Date().toISOString()
    }).eq('id', job.id)

    // Update site
    await supabaseAdmin.from('source_sites').update({
      status: 'analyzed',
      last_crawled_at: new Date().toISOString()
    }).eq('id', site.id)

    console.log(`[${WORKER_ID}] Done: ${url} → ${sectionCount} sections`)

  } catch (err: any) {
    console.error(`[${WORKER_ID}] Error:`, err.message)
    await failJob(job.id, 'PROCESSING_ERROR', err.message)
  } finally {
    await browser.close()
  }
}

async function pollLoop() {
  console.log(`[${WORKER_ID}] Worker started, polling every ${POLL_INTERVAL}ms`)
  await ensureBuckets()

  while (true) {
    try {
      const job = await claimJob()
      if (job) {
        await processJob(job)
      }
    } catch (err: any) {
      console.error(`[${WORKER_ID}] Poll error:`, err.message)
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }
}

pollLoop()
