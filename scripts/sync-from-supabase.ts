/**
 * Supabase → Local (.partcopy/) sync script
 * High-speed parallel download version
 */
import { createClient } from '@supabase/supabase-js'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'

const SB_URL = process.env.SUPABASE_URL || ''
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } })

const LOCAL_ROOT = path.resolve(process.cwd(), '.partcopy')
const STORAGE_ROOT = path.join(LOCAL_ROOT, 'storage')
const DB_PATH = path.join(LOCAL_ROOT, 'db.json')

const CONCURRENCY = 30 // parallel downloads

async function fetchAll(table: string) {
  const rows: any[] = []
  let offset = 0
  const limit = 1000
  while (true) {
    const { data, error } = await sb.from(table).select('*').range(offset, offset + limit - 1)
    if (error) { console.error(`  ERROR ${table}:`, error.message); break }
    if (!data || data.length === 0) break
    rows.push(...data)
    offset += data.length
    if (data.length < limit) break
  }
  console.log(`  ${table}: ${rows.length} rows`)
  return rows
}

async function listAllFiles(bucket: string, prefix = ''): Promise<string[]> {
  const paths: string[] = []
  const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 10000 })
  if (error || !data) return paths

  const folders: string[] = []
  for (const item of data) {
    const fullPath = prefix ? `${prefix}/${item.name}` : item.name
    if (item.id === null) {
      folders.push(fullPath)
    } else {
      paths.push(fullPath)
    }
  }

  // Recurse into folders in parallel
  if (folders.length > 0) {
    const results = await Promise.all(folders.map(f => listAllFiles(bucket, f)))
    for (const r of results) paths.push(...r)
  }
  return paths
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function downloadBatch(bucket: string, files: string[]) {
  let downloaded = 0
  let skipped = 0
  let failed = 0
  const startTime = Date.now()

  // Process in chunks of CONCURRENCY
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const chunk = files.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(async (filePath) => {
        const localPath = path.join(STORAGE_ROOT, bucket, filePath)

        // Skip if already downloaded
        if (await fileExists(localPath)) {
          skipped++
          return 'skipped'
        }

        await mkdir(path.dirname(localPath), { recursive: true })
        const { data, error } = await sb.storage.from(bucket).download(filePath)
        if (error || !data) throw new Error(error?.message || 'no data')
        const buffer = Buffer.from(await data.arrayBuffer())
        await writeFile(localPath, buffer)
        downloaded++
        return 'ok'
      })
    )

    for (const r of results) {
      if (r.status === 'rejected') failed++
    }

    const total = downloaded + skipped + failed
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
    const rate = (total / ((Date.now() - startTime) / 1000)).toFixed(1)
    process.stdout.write(
      `\r    ${total}/${files.length} (${downloaded} new, ${skipped} skip, ${failed} fail) ${rate}/s ${elapsed}s`
    )
  }

  console.log()
  return { downloaded, skipped, failed }
}

async function main() {
  await mkdir(LOCAL_ROOT, { recursive: true })
  await mkdir(STORAGE_ROOT, { recursive: true })

  // === Step 1: Download DB tables ===
  console.log('\n=== Downloading DB tables ===')

  const [
    source_sites, crawl_runs, source_pages, source_sections,
    block_families, block_variants, block_instances, page_assets,
    section_dom_snapshots, section_nodes, section_patch_sets,
    section_patches, project_page_blocks
  ] = await Promise.all([
    fetchAll('source_sites'),
    fetchAll('crawl_runs'),
    fetchAll('source_pages'),
    fetchAll('source_sections'),
    fetchAll('block_families'),
    fetchAll('block_variants'),
    fetchAll('block_instances'),
    fetchAll('page_assets'),
    fetchAll('section_dom_snapshots'),
    fetchAll('section_nodes'),
    fetchAll('section_patch_sets'),
    fetchAll('section_patches'),
    fetchAll('project_page_blocks'),
  ])

  const db = {
    source_sites, crawl_runs, source_pages, source_sections,
    page_assets, block_families, block_variants, block_instances,
    section_dom_snapshots, section_nodes, section_patch_sets,
    section_patches, project_page_blocks
  }

  await writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf-8')
  const totalRows = Object.values(db).reduce((sum, arr) => sum + arr.length, 0)
  console.log(`\n  db.json: ${totalRows} rows (${(JSON.stringify(db).length / 1024 / 1024).toFixed(1)} MB)`)

  // === Step 2: Download storage files (parallel) ===
  console.log('\n=== Downloading storage files (concurrency: ' + CONCURRENCY + ') ===')

  const buckets = [
    'corpus-raw-html',
    'corpus-sanitized-html',
    'corpus-page-screenshots',
    'corpus-section-thumbnails',
    'project-assets',
    'export-artifacts'
  ]

  let grandTotal = { downloaded: 0, skipped: 0, failed: 0 }

  for (const bucket of buckets) {
    process.stdout.write(`\n  [${bucket}] listing files...`)
    const files = await listAllFiles(bucket)
    console.log(` ${files.length} files`)

    if (files.length === 0) continue
    const result = await downloadBatch(bucket, files)
    grandTotal.downloaded += result.downloaded
    grandTotal.skipped += result.skipped
    grandTotal.failed += result.failed
  }

  console.log(`\n=== Sync complete ===`)
  console.log(`  DB: ${totalRows} rows`)
  console.log(`  Storage: ${grandTotal.downloaded} downloaded, ${grandTotal.skipped} skipped, ${grandTotal.failed} failed`)
}

main().catch(err => {
  console.error('Sync failed:', err)
  process.exit(1)
})
