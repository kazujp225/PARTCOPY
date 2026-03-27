/**
 * Fix 21 misclassified sections in .partcopy/db.json
 *
 * Rules applied in order (first match wins per section):
 *   1. FORM family -> contact
 *   2. relic.co.jp stats -> feature / company_profile / social_proof
 *   3. Hero page dumps (huge linkCount/cardCount/headingCount) -> feature
 *   4. apple.com content mentioning products -> feature
 *   5. Footer at low order_index on long pages -> content
 *   6. ai.watch.impress.co.jp pricing -> news_list
 *   7. otasukelp.com faq with "Feature" text -> feature
 *   8. Formless contact (no form, short text) -> cta
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'

const DB_PATH = path.resolve(process.cwd(), '.partcopy', 'db.json')

interface FeaturesJsonb {
  linkCount?: number
  cardCount?: number
  headingCount?: number
  formCount?: number
  hasForm?: boolean
  [key: string]: unknown
}

interface SourceSection {
  id: string
  page_id: string
  site_id: string
  order_index: number
  block_family: string
  features_jsonb: FeaturesJsonb | null
  text_summary: string | null
  [key: string]: unknown
}

interface SourceSite {
  id: string
  normalized_domain: string
  [key: string]: unknown
}

interface DB {
  source_sites: SourceSite[]
  source_sections: SourceSection[]
  [key: string]: unknown
}

// ── Helpers ──────────────────────────────────────────────────────────────

function domain(siteId: string, siteMap: Map<string, string>): string {
  return siteMap.get(siteId) ?? ''
}

function ts(section: SourceSection): string {
  return section.text_summary ?? ''
}

function feat(section: SourceSection): FeaturesJsonb {
  return section.features_jsonb ?? {}
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  console.log('Loading db.json ...')
  const raw = readFileSync(DB_PATH, 'utf-8')
  const db: DB = JSON.parse(raw)
  console.log(`  source_sites:    ${db.source_sites.length}`)
  console.log(`  source_sections: ${db.source_sections.length}`)

  // Build lookup: site_id -> normalized_domain
  const siteMap = new Map<string, string>()
  for (const site of db.source_sites) {
    siteMap.set(site.id, site.normalized_domain)
  }

  // Pre-compute page section counts for rule 5
  const pageSectionCount = new Map<string, number>()
  for (const sec of db.source_sections) {
    pageSectionCount.set(sec.page_id, (pageSectionCount.get(sec.page_id) ?? 0) + 1)
  }

  // Track changes per rule
  const counters: Record<string, number> = {
    'Rule 1: FORM -> contact': 0,
    'Rule 2a: relic feature (Business Produce)': 0,
    'Rule 2b: relic feature (Open Innovation)': 0,
    'Rule 2c: relic feature (Incubation Tech)': 0,
    'Rule 2d: relic feature (investment/Sales Marker)': 0,
    'Rule 2e: relic company_profile': 0,
    'Rule 2f: relic social_proof': 0,
    'Rule 3: hero dump -> feature': 0,
    'Rule 4: apple content -> feature': 0,
    'Rule 5: footer position -> content': 0,
    'Rule 6: ai.watch pricing -> news_list': 0,
    'Rule 7: otasukelp faq -> feature': 0,
    'Rule 8: formless contact -> cta': 0,
  }

  const changed = new Set<string>()

  function apply(section: SourceSection, newFamily: string, ruleKey: string): void {
    if (changed.has(section.id)) return // already changed by an earlier rule
    const old = section.block_family
    section.block_family = newFamily
    changed.add(section.id)
    counters[ruleKey]++
    console.log(`  [${ruleKey}] ${section.id.slice(0, 8)}  ${old} -> ${newFamily}`)
  }

  console.log('\nApplying rules ...\n')

  for (const sec of db.source_sections) {
    const dom = domain(sec.site_id, siteMap)
    const text = ts(sec)
    const f = feat(sec)
    const bf = sec.block_family

    // ── Rule 1: FORM family -> contact ───────────────────────────────
    if (bf.toUpperCase() === 'FORM') {
      apply(sec, 'contact', 'Rule 1: FORM -> contact')
      continue
    }

    // ── Rule 2: relic.co.jp stats fixes ──────────────────────────────
    if (dom === 'relic.co.jp' && bf === 'stats') {
      if (/事業プロデュース|Business Produce/i.test(text)) {
        apply(sec, 'feature', 'Rule 2a: relic feature (Business Produce)')
        continue
      }
      if (/オープンイノベーション|Open Innovation/i.test(text)) {
        apply(sec, 'feature', 'Rule 2b: relic feature (Open Innovation)')
        continue
      }
      if (/インキュベーションテック|Incubation Tech/i.test(text)) {
        apply(sec, 'feature', 'Rule 2c: relic feature (Incubation Tech)')
        continue
      }
      if (/投資・資本業務提携|Sales Marker/i.test(text)) {
        apply(sec, 'feature', 'Rule 2d: relic feature (investment/Sales Marker)')
        continue
      }
      if (/会社情報|会社概要|CompanyProfile|私たちについて|Aboutus/i.test(text)) {
        apply(sec, 'company_profile', 'Rule 2e: relic company_profile')
        continue
      }
      if (/特集|サービス大賞/i.test(text)) {
        apply(sec, 'social_proof', 'Rule 2f: relic social_proof')
        continue
      }
    }

    // ── Rule 3: Hero page dumps -> feature ───────────────────────────
    if (bf === 'hero') {
      if ((f.linkCount ?? 0) > 50 || (f.cardCount ?? 0) > 20 || (f.headingCount ?? 0) > 20) {
        apply(sec, 'feature', 'Rule 3: hero dump -> feature')
        continue
      }
    }

    // ── Rule 4: apple.com content -> feature ─────────────────────────
    if (dom === 'apple.com' && bf === 'content') {
      if (/iPhone|MacBook|Mac/i.test(text)) {
        apply(sec, 'feature', 'Rule 4: apple content -> feature')
        continue
      }
    }

    // ── Rule 5: Footer position fix -> content ───────────────────────
    if (bf === 'footer' && sec.order_index < 3) {
      const pageTotal = pageSectionCount.get(sec.page_id) ?? 0
      if (pageTotal > 5) {
        apply(sec, 'content', 'Rule 5: footer position -> content')
        continue
      }
    }

    // ── Rule 6: ai.watch.impress.co.jp pricing -> news_list ─────────
    if (dom === 'ai.watch.impress.co.jp' && bf === 'pricing') {
      apply(sec, 'news_list', 'Rule 6: ai.watch pricing -> news_list')
      continue
    }

    // ── Rule 7: otasukelp.com faq -> feature ─────────────────────────
    if (dom === 'otasukelp.com' && bf === 'faq') {
      if (/特徴|Feature/i.test(text)) {
        apply(sec, 'feature', 'Rule 7: otasukelp faq -> feature')
        continue
      }
    }

    // ── Rule 8: Formless contact -> cta ──────────────────────────────
    // hasForm is false OR formCount is explicitly 0 (not just undefined)
    if (bf === 'contact') {
      const noForm = f.hasForm === false || (f.formCount === 0)
      if (noForm && text.length < 100) {
        apply(sec, 'cta', 'Rule 8: formless contact -> cta')
        continue
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('\n── Summary ──────────────────────────────────────────────')
  let total = 0
  for (const [rule, count] of Object.entries(counters)) {
    if (count > 0) {
      console.log(`  ${rule}: ${count}`)
      total += count
    }
  }
  console.log(`  ────────────────────────────────────`)
  console.log(`  Total sections changed: ${total}`)

  if (total === 0) {
    console.log('\nNo changes needed. Skipping write.')
    return
  }

  // ── Write back atomically ──────────────────────────────────────────────
  const tmpPath = DB_PATH + '.tmp'
  const jsonStr = JSON.stringify(db, null, 2)
  console.log(`\nWriting ${(jsonStr.length / 1024 / 1024).toFixed(1)} MB to db.json ...`)
  writeFileSync(tmpPath, jsonStr, 'utf-8')

  // Verify the temp file can be parsed
  const verify: DB = JSON.parse(readFileSync(tmpPath, 'utf-8'))
  const verifySections = verify.source_sections.length
  if (verifySections !== db.source_sections.length) {
    console.error('ERROR: verification failed, section count mismatch!')
    process.exit(1)
  }

  // Atomic rename
  renameSync(tmpPath, DB_PATH)
  console.log('Done. db.json updated successfully.')
}

main()
