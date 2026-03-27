/**
 * Fix TSX storage path linkage in the local DB (.partcopy/db.json).
 *
 * Problem: All 259 source_sections have tsx_code_storage_path as undefined,
 * but TSX files exist on disk at .partcopy/storage/corpus-sanitized-html/.
 *
 * Strategy:
 *   1. Scan storage for *.tsx files, extract {site_id}/{crawl_run_id}/component_{N}.tsx
 *   2. For each file, find source_pages matching (site_id, crawl_run_id)
 *   3. For each matched page, find source_sections matching (page_id, order_index = N)
 *   4. Set tsx_code_storage_path on the matched section
 *   5. Write updated db.json
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

const LOCAL_ROOT = path.resolve(process.cwd(), '.partcopy')
const STORAGE_ROOT = path.join(LOCAL_ROOT, 'storage', 'corpus-sanitized-html')
const DB_PATH = path.join(LOCAL_ROOT, 'db.json')

interface SourceSection {
  id: string
  page_id: string
  site_id: string
  order_index: number
  tsx_code_storage_path?: string | null
  [key: string]: unknown
}

interface SourcePage {
  id: string
  crawl_run_id: string
  site_id: string
  [key: string]: unknown
}

interface DB {
  source_sections: SourceSection[]
  source_pages: SourcePage[]
  [key: string]: unknown
}

// ── 1. Discover all TSX files on disk ──────────────────────────────────
function discoverTsxFiles(): { siteId: string; crawlRunId: string; index: number; relativePath: string }[] {
  const results: { siteId: string; crawlRunId: string; index: number; relativePath: string }[] = []

  if (!existsSync(STORAGE_ROOT)) {
    console.error('Storage root does not exist:', STORAGE_ROOT)
    process.exit(1)
  }

  for (const siteDir of readdirSync(STORAGE_ROOT)) {
    const sitePath = path.join(STORAGE_ROOT, siteDir)
    if (!statSync(sitePath).isDirectory()) continue

    for (const crawlDir of readdirSync(sitePath)) {
      const crawlPath = path.join(sitePath, crawlDir)
      if (!statSync(crawlPath).isDirectory()) continue

      for (const file of readdirSync(crawlPath)) {
        const match = file.match(/^component_(\d+)\.tsx$/)
        if (match) {
          results.push({
            siteId: siteDir,
            crawlRunId: crawlDir,
            index: parseInt(match[1], 10),
            relativePath: `${siteDir}/${crawlDir}/${file}`,
          })
        }
      }
    }
  }

  return results
}

// ── Main ───────────────────────────────────────────────────────────────
function main() {
  console.log('Loading db.json ...')
  const db: DB = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
  console.log(`  source_sections: ${db.source_sections.length}`)
  console.log(`  source_pages:    ${db.source_pages.length}`)

  console.log('\nScanning TSX files on disk ...')
  const tsxFiles = discoverTsxFiles()
  console.log(`  Found ${tsxFiles.length} TSX files\n`)

  // Build lookup: (site_id, crawl_run_id) → page_id[]
  const pageIndex = new Map<string, string[]>()
  for (const page of db.source_pages) {
    const key = `${page.site_id}|${page.crawl_run_id}`
    if (!pageIndex.has(key)) pageIndex.set(key, [])
    pageIndex.get(key)!.push(page.id)
  }

  // Build lookup: (page_id, order_index) → section index in array
  const sectionIndex = new Map<string, number>()
  for (let i = 0; i < db.source_sections.length; i++) {
    const s = db.source_sections[i]
    const key = `${s.page_id}|${s.order_index}`
    sectionIndex.set(key, i)
  }

  let linked = 0
  let noPage = 0
  let noSection = 0

  for (const tsx of tsxFiles) {
    const pageKey = `${tsx.siteId}|${tsx.crawlRunId}`
    const pageIds = pageIndex.get(pageKey)

    if (!pageIds || pageIds.length === 0) {
      console.log(`  SKIP (no page): ${tsx.relativePath}`)
      noPage++
      continue
    }

    let matched = false
    for (const pageId of pageIds) {
      const secKey = `${pageId}|${tsx.index}`
      const secIdx = sectionIndex.get(secKey)
      if (secIdx !== undefined) {
        db.source_sections[secIdx].tsx_code_storage_path = tsx.relativePath
        console.log(`  LINKED: section ${db.source_sections[secIdx].id} ← ${tsx.relativePath}`)
        linked++
        matched = true
      }
    }

    if (!matched) {
      console.log(`  SKIP (no section with order_index=${tsx.index}): ${tsx.relativePath}`)
      noSection++
    }
  }

  console.log('\n── Summary ──────────────────────────────────')
  console.log(`  TSX files found:        ${tsxFiles.length}`)
  console.log(`  Sections linked:        ${linked}`)
  console.log(`  Skipped (no page):      ${noPage}`)
  console.log(`  Skipped (no section):   ${noSection}`)
  console.log(`  Total sections in DB:   ${db.source_sections.length}`)

  // Count how many sections now have tsx_code_storage_path set
  const withTsx = db.source_sections.filter(s => s.tsx_code_storage_path).length
  console.log(`  Sections with TSX path: ${withTsx}`)

  // Verify mutations before writing
  const verifyCount = db.source_sections.filter(s => s.tsx_code_storage_path).length
  console.log(`\nPre-write verification: ${verifyCount} sections have tsx_code_storage_path`)

  if (verifyCount === 0) {
    console.log('ERROR: No mutations detected, aborting write.')
    process.exit(1)
  }

  console.log('Writing updated db.json ...')
  const jsonStr = JSON.stringify(db, null, 2)
  const hasTsx = jsonStr.includes('tsx_code_storage_path')
  console.log(`  Serialized string contains tsx_code_storage_path: ${hasTsx}`)
  console.log(`  Serialized string length: ${jsonStr.length}`)
  writeFileSync(DB_PATH, jsonStr, 'utf-8')

  // Read back and verify
  const readBack = readFileSync(DB_PATH, 'utf-8')
  const readBackHasTsx = readBack.includes('tsx_code_storage_path')
  console.log(`  Read-back contains tsx_code_storage_path: ${readBackHasTsx}`)
  console.log('Done.')
}

main()
