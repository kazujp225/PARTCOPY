/**
 * Batch TSX Converter
 * Converts all sections to React TSX using claude -p CLI.
 * Tracks completion by checking if {sectionId}/component.tsx exists in storage.
 * Run with: npx tsx scripts/batch-tsx-convert.ts
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { convertHtmlToTsx } from '../server/claude-converter.js'

dotenv.config()

const CONCURRENCY = parseInt(process.env.TSX_CONCURRENCY || '5', 10)
const OFFSET = parseInt(process.env.TSX_OFFSET || '0', 10)
const CHUNK = parseInt(process.env.TSX_CHUNK || '0', 10) // 0 = all
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const RAW_HTML_BUCKET = 'corpus-raw-html'
const TSX_BUCKET = 'corpus-sanitized-html'

async function readBucketText(bucket: string, path: string | null): Promise<string | null> {
  if (!path) return null
  const { data, error } = await sb.storage.from(bucket).download(path)
  if (error || !data) return null
  return await data.text()
}

async function tsxExists(sectionId: string): Promise<boolean> {
  const { data } = await sb.storage.from(TSX_BUCKET).download(`${sectionId}/component.tsx`)
  return !!data
}

async function getAllSections(): Promise<Array<{ id: string; raw_html_storage_path: string; block_family: string }>> {
  const all: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from('source_sections')
      .select('id, raw_html_storage_path, block_family')
      .not('raw_html_storage_path', 'is', null)
      .order('created_at', { ascending: false })
      .range(from, from + 999)
    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  return all
}

async function convertOne(section: { id: string; raw_html_storage_path: string; block_family: string }): Promise<'skip' | 'ok' | 'err'> {
  try {
    // Check if already converted
    if (await tsxExists(section.id)) return 'skip'

    const html = await readBucketText(RAW_HTML_BUCKET, section.raw_html_storage_path)
    if (!html || html.trim().length < 50) return 'err'

    const tsx = await convertHtmlToTsx(html, section.block_family)
    if (!tsx || tsx.trim().length < 20) {
      console.error(`  [SKIP] ${section.id} - empty TSX`)
      return false
    }

    const tsxPath = `${section.id}/component.tsx`
    const tsxBuffer = Buffer.from(tsx, 'utf-8')
    const { error } = await sb.storage.from(TSX_BUCKET).upload(tsxPath, tsxBuffer, { contentType: 'text/plain', upsert: true })
    if (error) {
      console.error(`  [UPLOAD] ${section.id}: ${error.message}`)
      return 'err'
    }
    return 'ok'
  } catch (err: any) {
    console.error(`  [ERR] ${section.id}: ${err.message?.slice(0, 80)}`)
    return 'err'
  }
}

async function main() {
  console.log('=== PARTCOPY Batch TSX Converter ===')
  console.log('Fetching all sections...')
  const sections = await getAllSections()
  console.log(`Total sections: ${sections.length}`)

  // Apply offset/chunk for splitting across multiple processes
  let pool = sections
  if (OFFSET > 0) pool = pool.slice(OFFSET)
  if (CHUNK > 0) pool = pool.slice(0, CHUNK)
  console.log(`Processing range: offset=${OFFSET} chunk=${pool.length}`)
  console.log(`Skipping already-converted sections inline...`)
  return runConversion(pool)
}

async function runConversion(sections: Array<{ id: string; raw_html_storage_path: string; block_family: string }>) {
  if (sections.length === 0) {
    console.log('Nothing to convert!')
    return
  }

  console.log(`\nStarting conversion of ${sections.length} sections (${CONCURRENCY} parallel)...`)
  let done = 0, success = 0, errors = 0, skipped = 0
  const startTime = Date.now()

  for (let i = 0; i < sections.length; i += CONCURRENCY) {
    const batch = sections.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map(s => convertOne(s)))

    for (const r of results) {
      done++
      if (r.status === 'fulfilled') {
        if (r.value === 'ok') success++
        else if (r.value === 'skip') skipped++
        else errors++
      } else {
        errors++
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
    const converted = success + errors // actual work done (not skips)
    const rate = converted > 0 ? (converted / ((Date.now() - startTime) / 1000) * 60).toFixed(1) : '0'
    const remaining = sections.length - done
    const etaSec = done > 0 ? remaining / (done / ((Date.now() - startTime) / 1000)) : 0
    const eta = Math.round(etaSec / 60)
    if (done % CONCURRENCY === 0 || done === sections.length) {
      console.log(`[${done}/${sections.length}] OK:${success} SKIP:${skipped} ERR:${errors} | ${elapsed}s | ${rate}/min | ETA: ~${eta}min`)
    }
  }

  console.log(`\n=== COMPLETE ===`)
  console.log(`Converted: ${success}`)
  console.log(`Errors: ${errors}`)
  console.log(`Time: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`)
}

main().catch(console.error)
