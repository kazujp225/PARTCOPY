import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer'
import { parseSectionDOM } from '../server/dom-parser.js'

const sb = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

const BUCKET_SANITIZED = 'corpus-sanitized-html'
const BUCKET_RAW = 'corpus-raw-html'

type PageJoin = {
  id: string
  final_html_path?: string | null
  css_bundle_path?: string | null
  url?: string | null
}

type SectionRow = {
  id: string
  site_id: string
  page_id: string
  order_index: number
  dom_path: string | null
  source_pages?: PageJoin | PageJoin[] | null
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const normalizeJoin = <T,>(value: T | T[] | null | undefined): T | null => {
  if (!value) return null
  return Array.isArray(value) ? value[0] || null : value
}

async function downloadText(bucket: string, path: string) {
  const { data, error } = await sb.storage.from(bucket).download(path)
  if (error || !data) throw new Error(error?.message || `Missing file: ${bucket}/${path}`)
  return data.text()
}

async function uploadText(bucket: string, path: string, data: string, contentType: string) {
  const { error } = await sb.storage.from(bucket).upload(path, Buffer.from(data, 'utf-8'), {
    contentType,
    upsert: true
  })
  if (error) throw new Error(`Upload failed (${bucket}/${path}): ${error.message}`)
  return path
}

function buildSelfContainedPage(storedHtml: string, cssBundle: string, pageOrigin: string) {
  const withoutStylesheets = storedHtml.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '')
  const sanitized = withoutStylesheets
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')

  const injection = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<base href="${pageOrigin}/">`,
    `<style>${cssBundle}</style>`
  ].join('')

  if (/<html[\s>]/i.test(sanitized)) {
    let html = sanitized
    if (!/<head[\s>]/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, '<html$1><head></head>')
    }
    if (/<\/head>/i.test(html)) {
      return html.replace(/<\/head>/i, `${injection}</head>`)
    }
    return html.replace(/<head([^>]*)>/i, `<head$1>${injection}`)
  }

  return `<!DOCTYPE html>
<html lang="ja">
<head>${injection}</head>
<body>${sanitized}</body>
</html>`
}

async function main() {
  const { data: sections, error } = await sb
    .from('source_sections')
    .select(`
      id,
      site_id,
      page_id,
      order_index,
      dom_path,
      source_pages!inner(id, final_html_path, css_bundle_path, url)
    `)
    .not('dom_path', 'is', null)
    .order('page_id')
    .order('order_index')

  if (error || !sections) {
    console.error('Failed to fetch sections:', error?.message)
    return
  }

  const { data: existingSnapshots, error: snapshotError } = await sb
    .from('section_dom_snapshots')
    .select('section_id')
    .eq('snapshot_type', 'resolved')

  if (snapshotError) {
    console.error('Failed to fetch existing snapshots:', snapshotError.message)
    return
  }

  const existingIds = new Set((existingSnapshots || []).map(row => row.section_id))
  const pendingSections = (sections as SectionRow[]).filter(section => {
    const pageInfo = normalizeJoin(section.source_pages)
    return !existingIds.has(section.id) && Boolean(section.dom_path) && Boolean(pageInfo?.final_html_path)
  })

  console.log(`Sections to backfill: ${pendingSections.length} / ${sections.length}`)
  if (pendingSections.length === 0) return

  const grouped = new Map<string, SectionRow[]>()
  for (const section of pendingSections) {
    const list = grouped.get(section.page_id) || []
    list.push(section)
    grouped.set(section.page_id, list)
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })

    for (const [pageId, pageSections] of grouped) {
      const pageInfo = normalizeJoin(pageSections[0].source_pages)
      if (!pageInfo?.final_html_path) continue

      try {
        const [finalHtml, cssBundle] = await Promise.all([
          downloadText(BUCKET_RAW, pageInfo.final_html_path),
          pageInfo.css_bundle_path ? downloadText(BUCKET_RAW, pageInfo.css_bundle_path) : Promise.resolve('')
        ])

        const pageOrigin = pageInfo.url ? new URL(pageInfo.url).origin : ''
        const renderHtml = buildSelfContainedPage(finalHtml, cssBundle, pageOrigin)
        await page.setContent(renderHtml, { waitUntil: 'domcontentloaded' })
        await sleep(500)

        for (const section of pageSections) {
          try {
            const snapshot = await parseSectionDOM(page, {
              domPath: section.dom_path || '',
              outerHTML: ''
            }, section.order_index)

            if (!snapshot.resolvedHtml || snapshot.nodes.length === 0) {
              console.log(`Skip ${section.id}: empty snapshot`)
              continue
            }

            const resolvedPath = `${section.site_id}/${pageId}/resolved_${section.order_index}.html`
            const domJsonPath = `${section.site_id}/${pageId}/dom_${section.order_index}.json`

            await uploadText(BUCKET_SANITIZED, resolvedPath, snapshot.resolvedHtml, 'text/html')
            await uploadText(BUCKET_SANITIZED, domJsonPath, JSON.stringify(snapshot.nodes), 'application/json')

            const { data: snapshotRow, error: insertSnapshotError } = await sb
              .from('section_dom_snapshots')
              .insert({
                section_id: section.id,
                snapshot_type: 'resolved',
                html_storage_path: resolvedPath,
                dom_json_path: domJsonPath,
                node_count: snapshot.nodeCount,
                css_strategy: 'resolved_inline'
              })
              .select('id')
              .single()

            if (insertSnapshotError || !snapshotRow) {
              throw new Error(insertSnapshotError?.message || 'Failed to insert snapshot row')
            }

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

            if (nodeRecords.length > 0) {
              await sb.from('section_nodes').insert(nodeRecords)
            }

            console.log(`Backfilled ${section.id}: ${nodeRecords.length} nodes`)
          } catch (sectionError: any) {
            console.error(`Section backfill failed ${section.id}:`, sectionError.message)
          }
        }
      } catch (pageError: any) {
        console.error(`Page backfill failed ${pageId}:`, pageError.message)
      }
    }
  } finally {
    await browser.close()
  }

  console.log('Backfill complete')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
