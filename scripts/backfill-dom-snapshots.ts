/**
 * Backfill: 既存セクションに対して DOM snapshot + nodes を生成する。
 * Worker の Phase 5.5 相当の処理をバッチ実行。
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer'

const sb = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

const BUCKET_SANITIZED = 'corpus-sanitized-html'
const BUCKET_RAW = 'corpus-raw-html'

async function uploadBuffer(bucket: string, path: string, data: string, contentType: string) {
  const buffer = Buffer.from(data, 'utf-8')
  const { error } = await sb.storage.from(bucket).upload(path, buffer, { contentType, upsert: true })
  if (error) throw new Error(`Upload failed: ${error.message}`)
  return path
}

async function main() {
  // Get all sections that don't have a dom_snapshot yet
  const { data: sections, error } = await sb
    .from('source_sections')
    .select('id, raw_html_storage_path, page_id, site_id, order_index')
    .not('raw_html_storage_path', 'is', null)
    .order('created_at')

  if (error || !sections) {
    console.error('Failed to fetch sections:', error?.message)
    return
  }

  // Filter out sections that already have snapshots
  const { data: existingSnapshots } = await sb
    .from('section_dom_snapshots')
    .select('section_id')

  const existingIds = new Set((existingSnapshots || []).map(s => s.section_id))
  const toProcess = sections.filter(s => !existingIds.has(s.id))

  console.log(`Sections to process: ${toProcess.length} / ${sections.length} total`)
  if (toProcess.length === 0) return

  // Process each section
  for (const sec of toProcess) {
    try {
      // Download raw HTML
      const { data: htmlFile } = await sb.storage
        .from(BUCKET_RAW)
        .download(sec.raw_html_storage_path)

      if (!htmlFile) {
        console.log(`Skip ${sec.id}: HTML not found`)
        continue
      }

      const outerHTML = await htmlFile.text()

      // Parse DOM in a simple way (no Puppeteer needed for parsing)
      // We use DOMParser-like logic directly
      const DANGEROUS_TAGS = ['script', 'noscript', 'iframe', 'object', 'embed', 'applet']
      let sanitizedHtml = outerHTML

      // Remove dangerous tags
      for (const tag of DANGEROUS_TAGS) {
        const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi')
        sanitizedHtml = sanitizedHtml.replace(re, '')
        const reSelf = new RegExp(`<${tag}[^>]*\\/?>`, 'gi')
        sanitizedHtml = sanitizedHtml.replace(reSelf, '')
      }

      // Remove event handlers
      sanitizedHtml = sanitizedHtml.replace(/\s+on\w+\s*=\s*(['"])[^'"]*\1/gi, '')

      // Add data-pc-key to editable elements
      const EDITABLE_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'img', 'span', 'li', 'input', 'textarea', 'figcaption', 'blockquote', 'label', 'small']
      let nodeCounter = 0
      const nodesData: any[] = []

      for (const tag of EDITABLE_TAGS) {
        const re = new RegExp(`<${tag}(\\s|>)`, 'gi')
        sanitizedHtml = sanitizedHtml.replace(re, (match, after) => {
          const key = `s${sec.order_index}.${tag}[${nodeCounter}]`
          nodeCounter++

          // Determine node type
          let nodeType = 'other'
          if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) nodeType = 'heading'
          else if (tag === 'p') nodeType = 'paragraph'
          else if (tag === 'a') nodeType = 'link'
          else if (tag === 'button') nodeType = 'button'
          else if (tag === 'img') nodeType = 'image'
          else if (['span', 'figcaption', 'blockquote', 'label', 'small'].includes(tag)) nodeType = 'text'
          else if (tag === 'li') nodeType = 'list_item'
          else if (['input', 'textarea'].includes(tag)) nodeType = 'input'

          nodesData.push({
            stableKey: key,
            nodeType,
            tagName: tag,
            orderIndex: nodeCounter - 1,
            editable: true
          })

          return `<${tag} data-pc-key="${key}"${after}`
        })
      }

      // Upload resolved HTML
      const resolvedPath = `${sec.site_id}/${sec.page_id}/resolved_${sec.order_index}.html`
      await uploadBuffer(BUCKET_SANITIZED, resolvedPath, sanitizedHtml, 'text/html')

      // Upload DOM JSON
      const domJsonPath = `${sec.site_id}/${sec.page_id}/dom_${sec.order_index}.json`
      await uploadBuffer(BUCKET_SANITIZED, domJsonPath, JSON.stringify(nodesData), 'application/json')

      // Create snapshot record
      const { data: snapshot } = await sb
        .from('section_dom_snapshots')
        .insert({
          section_id: sec.id,
          snapshot_type: 'resolved',
          html_storage_path: resolvedPath,
          dom_json_path: domJsonPath,
          node_count: nodeCounter,
          css_strategy: 'bundle'
        })
        .select()
        .single()

      // Create node records
      if (snapshot && nodesData.length > 0) {
        const nodeRecords = nodesData.slice(0, 200).map(n => ({
          snapshot_id: snapshot.id,
          stable_key: n.stableKey,
          node_type: n.nodeType,
          tag_name: n.tagName,
          order_index: n.orderIndex,
          editable: true,
          attrs_jsonb: {},
          computed_style_jsonb: {}
        }))

        await sb.from('section_nodes').insert(nodeRecords)
      }

      console.log(`Processed ${sec.id}: ${nodeCounter} nodes`)
    } catch (err: any) {
      console.error(`Error processing ${sec.id}:`, err.message)
    }
  }

  console.log('Backfill complete')
}

main()
