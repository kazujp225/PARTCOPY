/**
 * cleanup-sections.ts
 *
 * Removes duplicate, garbage, and oversized sections from .partcopy/db.json.
 *
 * 1. Duplicates: same page_id + block_family + first 50 chars of text_summary.
 *    Keeps the first occurrence (lowest order_index), removes the rest.
 * 2. Garbage: text_summary is empty / whitespace-only / contains only HTML tags
 *    with fewer than 20 chars of actual text content AND starts with "<".
 * 3. Oversized: features_jsonb.cardCount > 50 OR linkCount > 100 OR headingCount > 30.
 *
 * Also cleans up referencing rows in:
 *   - section_dom_snapshots  (section_id)
 *   - section_nodes          (snapshot_id, transitively)
 *   - block_instances        (source_section_id)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = resolve(__dirname, '..', '.partcopy', 'db.json')

interface Section {
  id: string
  page_id: string
  block_family: string | null
  order_index: number
  text_summary: string | null
  features_jsonb: {
    cardCount?: number
    linkCount?: number
    headingCount?: number
    [k: string]: unknown
  } | null
  [k: string]: unknown
}

interface Snapshot {
  id: string
  section_id: string
  [k: string]: unknown
}

interface SectionNode {
  id: string
  snapshot_id: string
  [k: string]: unknown
}

interface BlockInstance {
  id: string
  source_section_id: string
  [k: string]: unknown
}

interface DB {
  source_sections: Section[]
  section_dom_snapshots: Snapshot[]
  section_nodes: SectionNode[]
  block_instances: BlockInstance[]
  [k: string]: unknown
}

// ── helpers ──────────────────────────────────────────────────────────

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim()
}

// ── detection ────────────────────────────────────────────────────────

function findDuplicates(sections: Section[]): { keep: Set<string>; remove: Set<string> } {
  const groups = new Map<string, Section[]>()

  for (const s of sections) {
    const prefix = (s.text_summary ?? '').slice(0, 50)
    const key = `${s.page_id}|${s.block_family ?? ''}|${prefix}`
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }

  const keep = new Set<string>()
  const remove = new Set<string>()

  for (const [, group] of groups) {
    if (group.length <= 1) continue
    // sort by order_index ascending, keep the first
    group.sort((a, b) => a.order_index - b.order_index)
    keep.add(group[0].id)
    for (let i = 1; i < group.length; i++) {
      remove.add(group[i].id)
    }
  }

  return { keep, remove }
}

function findGarbage(sections: Section[]): Set<string> {
  const ids = new Set<string>()

  for (const s of sections) {
    const raw = (s.text_summary ?? '').trim()

    // Empty or whitespace-only
    if (!raw) {
      ids.add(s.id)
      continue
    }

    // HTML tags only: starts with "<" and stripped text < 20 chars
    if (raw.startsWith('<')) {
      const stripped = stripHtmlTags(raw)
      if (stripped.length < 20) {
        ids.add(s.id)
        continue
      }
    }

    // Whitespace / newlines only (no visible text after stripping whitespace)
    const visible = raw.replace(/\s+/g, '')
    if (visible.length === 0) {
      ids.add(s.id)
      continue
    }
  }

  return ids
}

function findOversized(sections: Section[]): Set<string> {
  const ids = new Set<string>()

  for (const s of sections) {
    const f = s.features_jsonb ?? {}
    if (
      (f.cardCount ?? 0) > 50 ||
      (f.linkCount ?? 0) > 100 ||
      (f.headingCount ?? 0) > 30
    ) {
      ids.add(s.id)
    }
  }

  return ids
}

// ── main ─────────────────────────────────────────────────────────────

function main() {
  console.log(`Reading ${DB_PATH} ...`)
  const db: DB = JSON.parse(readFileSync(DB_PATH, 'utf-8'))

  const before = {
    sections: db.source_sections.length,
    snapshots: db.section_dom_snapshots.length,
    nodes: db.section_nodes.length,
    instances: db.block_instances.length,
  }

  console.log(`\nBefore cleanup:`)
  console.log(`  source_sections:        ${before.sections}`)
  console.log(`  section_dom_snapshots:   ${before.snapshots}`)
  console.log(`  section_nodes:           ${before.nodes}`)
  console.log(`  block_instances:         ${before.instances}`)

  // ── detect ──
  const { remove: duplicateIds } = findDuplicates(db.source_sections)
  const garbageIds = findGarbage(db.source_sections)
  const oversizedIds = findOversized(db.source_sections)

  // Merge into a single removal set (de-duplicated)
  const removeIds = new Set<string>([...duplicateIds, ...garbageIds, ...oversizedIds])

  // ── dry-run report ──
  console.log(`\n=== DRY-RUN REPORT ===`)
  console.log(`  Duplicates to remove:   ${duplicateIds.size}`)
  console.log(`  Garbage to remove:      ${garbageIds.size}`)
  console.log(`  Oversized to remove:    ${oversizedIds.size}`)

  // Check overlaps
  let dupGarbage = 0, dupOversized = 0, garbageOversized = 0
  for (const id of duplicateIds) {
    if (garbageIds.has(id)) dupGarbage++
    if (oversizedIds.has(id)) dupOversized++
  }
  for (const id of garbageIds) {
    if (oversizedIds.has(id)) garbageOversized++
  }
  if (dupGarbage || dupOversized || garbageOversized) {
    console.log(`  Overlaps: dup&garbage=${dupGarbage}, dup&oversized=${dupOversized}, garbage&oversized=${garbageOversized}`)
  }

  console.log(`  ─────────────────────────────`)
  console.log(`  Total unique sections:  ${removeIds.size} / ${db.source_sections.length}`)

  if (removeIds.size === 0) {
    console.log('\nNothing to remove. Exiting.')
    return
  }

  // List details
  console.log(`\n── Duplicate section IDs ──`)
  for (const id of duplicateIds) {
    const s = db.source_sections.find(x => x.id === id)!
    console.log(`  ${id}  page=${s.page_id}  family=${s.block_family}  order=${s.order_index}`)
  }

  console.log(`\n── Garbage section IDs ──`)
  for (const id of garbageIds) {
    const s = db.source_sections.find(x => x.id === id)!
    const preview = JSON.stringify(s.text_summary ?? '').slice(0, 60)
    console.log(`  ${id}  family=${s.block_family}  text=${preview}`)
  }

  console.log(`\n── Oversized section IDs ──`)
  for (const id of oversizedIds) {
    const s = db.source_sections.find(x => x.id === id)!
    const f = s.features_jsonb ?? {}
    console.log(`  ${id}  family=${s.block_family}  cards=${f.cardCount ?? 0}  links=${f.linkCount ?? 0}  headings=${f.headingCount ?? 0}`)
  }

  // ── perform removal ──
  console.log(`\nProceeding with removal ...`)

  // 1. Remove source_sections
  db.source_sections = db.source_sections.filter(s => !removeIds.has(s.id))

  // 2. Find snapshot IDs that belong to removed sections
  const removedSnapshotIds = new Set<string>()
  const keptSnapshots: Snapshot[] = []
  for (const snap of db.section_dom_snapshots) {
    if (removeIds.has(snap.section_id)) {
      removedSnapshotIds.add(snap.id)
    } else {
      keptSnapshots.push(snap)
    }
  }
  db.section_dom_snapshots = keptSnapshots

  // 3. Remove section_nodes whose snapshot_id is in removedSnapshotIds
  db.section_nodes = db.section_nodes.filter(n => !removedSnapshotIds.has(n.snapshot_id))

  // 4. Remove block_instances referencing removed sections
  db.block_instances = db.block_instances.filter(bi => !removeIds.has(bi.source_section_id))

  const after = {
    sections: db.source_sections.length,
    snapshots: db.section_dom_snapshots.length,
    nodes: db.section_nodes.length,
    instances: db.block_instances.length,
  }

  console.log(`\nAfter cleanup:`)
  console.log(`  source_sections:        ${after.sections}  (removed ${before.sections - after.sections})`)
  console.log(`  section_dom_snapshots:   ${after.snapshots}  (removed ${before.snapshots - after.snapshots})`)
  console.log(`  section_nodes:           ${after.nodes}  (removed ${before.nodes - after.nodes})`)
  console.log(`  block_instances:         ${after.instances}  (removed ${before.instances - after.instances})`)

  // ── write back ──
  console.log(`\nWriting cleaned db.json ...`)
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n', 'utf-8')
  console.log('Done.')
}

main()
