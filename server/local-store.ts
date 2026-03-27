import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const LOCAL_ROOT = path.resolve(process.cwd(), '.partcopy')
const STORAGE_ROOT = path.join(LOCAL_ROOT, 'storage')
const DB_PATH = path.join(LOCAL_ROOT, 'db.json')
const NODES_PATH = path.join(LOCAL_ROOT, 'nodes.json')
const LOCK_PATH = path.join(LOCAL_ROOT, '.lock')

type JsonObject = Record<string, any>

interface SourceSiteRow extends JsonObject {
  id: string
  normalized_domain: string
  homepage_url: string
  genre: string
  tags: string[]
  industry?: string
  company_type?: string
  language?: string
  status: string
  first_seen_at: string
  last_crawled_at?: string | null
}

interface CrawlRunRow extends JsonObject {
  id: string
  site_id: string
  project_id?: string | null
  trigger_type: string
  status: string
  worker_id?: string | null
  worker_version?: string | null
  error_code?: string | null
  error_message?: string | null
  status_detail?: string | null
  page_count: number
  section_count: number
  max_pages: number
  queued_at: string
  started_at?: string | null
  finished_at?: string | null
}

interface SourcePageRow extends JsonObject {
  id: string
  crawl_run_id: string
  site_id: string
  url: string
  path: string
  page_type: string
  title?: string
  css_bundle_path?: string
  screenshot_storage_path?: string
  final_html_path?: string
  request_log_path?: string
  created_at: string
}

interface SourceSectionRow extends JsonObject {
  id: string
  page_id: string
  site_id: string
  order_index: number
  block_family?: string
  block_variant?: string
  classifier_confidence?: number
  text_summary?: string
  features_jsonb?: Record<string, any>
  raw_html_storage_path?: string
  sanitized_html_storage_path?: string
  thumbnail_storage_path?: string
  tsx_code_storage_path?: string
  created_at: string
}

interface BlockFamilyRow extends JsonObject {
  id: string
  key: string
  label: string
  label_ja: string
  sort_order: number
}

interface BlockVariantRow extends JsonObject {
  id: string
  family_key: string
  variant_key: string
  label: string
  slot_schema_json: Record<string, any>
  created_at: string
}

interface SectionDomSnapshotRow extends JsonObject {
  id: string
  section_id: string
  snapshot_type: string
  html_storage_path: string
  dom_json_path?: string | null
  node_count: number
  css_strategy: string
  created_at: string
}

interface SectionNodeRow extends JsonObject {
  id: string
  snapshot_id: string
  stable_key: string
  order_index: number
  created_at: string
}

interface SectionPatchSetRow extends JsonObject {
  id: string
  section_id: string
  project_id?: string | null
  base_snapshot_id: string
  label?: string | null
  created_at: string
  updated_at: string
}

interface SectionPatchRow extends JsonObject {
  id: string
  patch_set_id: string
  node_stable_key: string
  op: string
  payload_jsonb: Record<string, any>
  order_index: number
  created_at: string
}

interface ProjectPageBlockRow extends JsonObject {
  id: string
  created_at: string
}

interface ProjectRow extends JsonObject {
  id: string
  name: string
  canvas_json: any[]
  created_at: string
}

interface LocalDB {
  source_sites: SourceSiteRow[]
  crawl_runs: CrawlRunRow[]
  source_pages: SourcePageRow[]
  source_sections: SourceSectionRow[]
  page_assets: JsonObject[]
  block_families: BlockFamilyRow[]
  block_variants: BlockVariantRow[]
  block_instances: JsonObject[]
  section_dom_snapshots: SectionDomSnapshotRow[]
  section_nodes: SectionNodeRow[]
  section_patch_sets: SectionPatchSetRow[]
  section_patches: SectionPatchRow[]
  project_page_blocks: ProjectPageBlockRow[]
  projects: ProjectRow[]
}

const FAMILY_SEEDS = [
  ['navigation', 'Navigation', 'ナビゲーション', 1],
  ['hero', 'Hero', 'ヒーロー', 2],
  ['feature', 'Feature', '特徴・サービス', 3],
  ['social_proof', 'Social Proof', '導入実績・信頼', 4],
  ['stats', 'Stats', '数字・実績', 5],
  ['pricing', 'Pricing', '料金プラン', 6],
  ['faq', 'FAQ', 'よくある質問', 7],
  ['content', 'Content', 'コンテンツ', 8],
  ['cta', 'CTA', 'CTA', 9],
  ['contact', 'Contact', 'お問い合わせ', 10],
  ['recruit', 'Recruit', '採用', 11],
  ['footer', 'Footer', 'フッター', 12],
  ['news_list', 'News List', 'お知らせ', 13],
  ['timeline', 'Timeline', '沿革・タイムライン', 14],
  ['company_profile', 'Company Profile', '会社概要', 15],
  ['gallery', 'Gallery', 'ギャラリー', 16],
  ['logo_cloud', 'Logo Cloud', 'ロゴ一覧', 17]
] as const

const VARIANT_SEEDS = [
  ['hero', 'hero_centered', 'Hero Centered'],
  ['hero', 'hero_split_left', 'Hero Split Left'],
  ['hero', 'hero_split_right', 'Hero Split Right'],
  ['hero', 'hero_with_trust', 'Hero + Trust Strip'],
  ['feature', 'feature_grid_3', 'Feature Grid 3-col'],
  ['feature', 'feature_grid_4', 'Feature Grid 4-col'],
  ['feature', 'feature_grid_6', 'Feature Grid 6-col'],
  ['feature', 'feature_alternating', 'Feature Alternating'],
  ['pricing', 'pricing_3col', 'Pricing 3-Column'],
  ['pricing', 'pricing_toggle', 'Pricing Toggle'],
  ['faq', 'faq_accordion', 'FAQ Accordion'],
  ['faq', 'faq_2col', 'FAQ 2-Column'],
  ['cta', 'cta_banner_single', 'CTA Banner'],
  ['cta', 'cta_banner_dual', 'CTA Banner Dual'],
  ['contact', 'contact_form_full', 'Contact Full Form'],
  ['contact', 'contact_split', 'Contact Split'],
  ['footer', 'footer_sitemap', 'Footer Sitemap'],
  ['footer', 'footer_minimal', 'Footer Minimal'],
  ['navigation', 'nav_simple', 'Navigation Simple'],
  ['navigation', 'nav_mega', 'Navigation Mega Menu'],
  ['social_proof', 'testimonial_cards', 'Testimonial Cards'],
  ['social_proof', 'logo_strip', 'Logo Strip'],
  ['stats', 'stats_row', 'Stats Row'],
  ['stats', 'stats_with_text', 'Stats + Description']
] as const

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function now() {
  return new Date().toISOString()
}

function createDefaultDb(): LocalDB {
  const createdAt = now()
  return {
    source_sites: [],
    crawl_runs: [],
    source_pages: [],
    source_sections: [],
    page_assets: [],
    block_families: FAMILY_SEEDS.map(([key, label, labelJa, sortOrder]) => ({
      id: randomUUID(),
      key,
      label,
      label_ja: labelJa,
      sort_order: sortOrder
    })),
    block_variants: VARIANT_SEEDS.map(([familyKey, variantKey, label]) => ({
      id: randomUUID(),
      family_key: familyKey,
      variant_key: variantKey,
      label,
      slot_schema_json: {},
      created_at: createdAt
    })),
    block_instances: [],
    section_dom_snapshots: [],
    section_nodes: [],
    section_patch_sets: [],
    section_patches: [],
    project_page_blocks: [],
    projects: []
  }
}

async function ensureLocalRoot() {
  await mkdir(LOCAL_ROOT, { recursive: true })
  await mkdir(STORAGE_ROOT, { recursive: true })

  try {
    await readFile(DB_PATH, 'utf-8')
  } catch {
    await writeFile(DB_PATH, JSON.stringify(createDefaultDb(), null, 2), 'utf-8')
  }
}

async function acquireLock() {
  await ensureLocalRoot()
  const MAX_WAIT = 10000 // 10s max
  const start = Date.now()
  while (true) {
    try {
      await mkdir(LOCK_PATH)
      return
    } catch {
      if (Date.now() - start > MAX_WAIT) {
        // Stale lock — force remove and retry
        await rm(LOCK_PATH, { recursive: true, force: true })
        await mkdir(LOCK_PATH)
        return
      }
      await delay(25)
    }
  }
}

async function releaseLock() {
  await rm(LOCK_PATH, { recursive: true, force: true })
}

async function readNodes(): Promise<SectionNodeRow[]> {
  try {
    const raw = await readFile(NODES_PATH, 'utf-8')
    return JSON.parse(raw) as SectionNodeRow[]
  } catch {
    return []
  }
}

async function writeNodes(nodes: SectionNodeRow[]) {
  const tempPath = `${NODES_PATH}.tmp`
  await writeFile(tempPath, JSON.stringify(nodes), 'utf-8')
  await rename(tempPath, NODES_PATH)
}

async function readDb(): Promise<LocalDB> {
  await ensureLocalRoot()
  const raw = await readFile(DB_PATH, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<LocalDB>
  const defaults = createDefaultDb()

  // section_nodes は別ファイルから遅延読み込み（メインDBに残っていれば移行）
  let nodes = parsed.section_nodes || []
  if (nodes.length === 0) {
    nodes = await readNodes()
  }

  return {
    ...defaults,
    ...parsed,
    section_nodes: nodes,
    block_families: parsed.block_families?.length ? parsed.block_families : defaults.block_families,
    block_variants: parsed.block_variants?.length ? parsed.block_variants : defaults.block_variants
  }
}

async function writeDb(db: LocalDB) {
  await ensureLocalRoot()

  // section_nodes を別ファイルに書き出し、メインDBからは除外
  const nodes = db.section_nodes
  await writeNodes(nodes)

  const dbWithoutNodes = { ...db, section_nodes: [] as SectionNodeRow[] }
  const tempPath = `${DB_PATH}.tmp`
  await writeFile(tempPath, JSON.stringify(dbWithoutNodes, null, 2), 'utf-8')
  await rename(tempPath, DB_PATH)
}

async function withWriteLock<T>(fn: (db: LocalDB) => Promise<T> | T): Promise<T> {
  await acquireLock()
  try {
    const db = await readDb()
    const result = await fn(db)
    await writeDb(db)
    return result
  } finally {
    await releaseLock()
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function toArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(item => typeof item === 'string')
}

function sanitizeStoragePath(storagePath: string) {
  const normalized = path.posix.normalize(String(storagePath || '').replace(/^\/+/, ''))
  if (!normalized || normalized.startsWith('..')) {
    throw new Error('Invalid storage path')
  }
  return normalized
}

function resolveAbsoluteStoragePath(bucket: string, storagePath: string) {
  const safePath = sanitizeStoragePath(storagePath)
  const baseDir = path.resolve(STORAGE_ROOT, bucket)
  const absolutePath = path.resolve(baseDir, safePath)

  if (absolutePath !== baseDir && !absolutePath.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error('Invalid storage path')
  }

  return { absolutePath, safePath }
}

function guessContentType(storagePath: string) {
  const lower = storagePath.toLowerCase()
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8'
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8'
  if (lower.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.woff')) return 'font/woff'
  if (lower.endsWith('.woff2')) return 'font/woff2'
  if (lower.endsWith('.ttf')) return 'font/ttf'
  if (lower.endsWith('.otf')) return 'font/otf'
  return 'application/octet-stream'
}

export async function writeStoredFile(bucket: string, storagePath: string, data: Buffer | string, contentType: string) {
  await ensureLocalRoot()
  const { absolutePath, safePath } = resolveAbsoluteStoragePath(bucket, storagePath)
  await mkdir(path.dirname(absolutePath), { recursive: true })
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
  await writeFile(absolutePath, buffer)
  await writeFile(`${absolutePath}.meta.json`, JSON.stringify({ contentType }, null, 2), 'utf-8')
  return safePath
}

export async function readStoredText(bucket: string, storagePath: string) {
  const { absolutePath } = resolveAbsoluteStoragePath(bucket, storagePath)
  return readFile(absolutePath, 'utf-8')
}

export async function readStoredBuffer(bucket: string, storagePath: string) {
  const { absolutePath } = resolveAbsoluteStoragePath(bucket, storagePath)
  return readFile(absolutePath)
}

export async function readStoredContentType(bucket: string, storagePath: string) {
  const { absolutePath, safePath } = resolveAbsoluteStoragePath(bucket, storagePath)
  try {
    const meta = JSON.parse(await readFile(`${absolutePath}.meta.json`, 'utf-8')) as { contentType?: string }
    return meta.contentType || guessContentType(safePath)
  } catch {
    return guessContentType(safePath)
  }
}

export function getStoredFileUrl(_bucket: string, storagePath: string) {
  return `/assets/${sanitizeStoragePath(storagePath)}`
}

export async function getStoredFileResponse(bucket: string, storagePath: string) {
  return {
    buffer: await readStoredBuffer(bucket, storagePath),
    contentType: await readStoredContentType(bucket, storagePath)
  }
}

export async function upsertSourceSite(input: {
  normalized_domain: string
  homepage_url: string
  genre?: string
  tags?: string[]
  status?: string
}) {
  return withWriteLock(async db => {
    const existing = db.source_sites.find(site => site.normalized_domain === input.normalized_domain)
    if (existing) {
      existing.homepage_url = input.homepage_url
      existing.genre = input.genre || existing.genre || ''
      existing.tags = [...new Set([...(existing.tags || []), ...toArray(input.tags)])]
      existing.status = input.status || existing.status
      return clone(existing)
    }

    const site: SourceSiteRow = {
      id: randomUUID(),
      normalized_domain: input.normalized_domain,
      homepage_url: input.homepage_url,
      genre: input.genre || '',
      tags: toArray(input.tags),
      status: input.status || 'queued',
      language: 'ja',
      first_seen_at: now(),
      last_crawled_at: null
    }
    db.source_sites.push(site)
    return clone(site)
  })
}

export async function updateSourceSite(siteId: string, patch: Partial<SourceSiteRow>) {
  return withWriteLock(async db => {
    const site = db.source_sites.find(row => row.id === siteId)
    if (!site) return null
    Object.assign(site, patch)
    return clone(site)
  })
}

export async function createCrawlRun(input: { site_id: string; trigger_type?: string; status?: string; max_pages?: number }) {
  return withWriteLock(async db => {
    const job: CrawlRunRow = {
      id: randomUUID(),
      site_id: input.site_id,
      trigger_type: input.trigger_type || 'manual',
      status: input.status || 'queued',
      page_count: 0,
      section_count: 0,
      max_pages: input.max_pages ?? 5,
      queued_at: now(),
      started_at: null,
      finished_at: null
    }
    db.crawl_runs.push(job)
    return clone(job)
  })
}

export async function getJob(jobId: string) {
  const db = await readDb()
  const job = db.crawl_runs.find(row => row.id === jobId)
  if (!job) return null
  const site = db.source_sites.find(row => row.id === job.site_id)
  return clone({
    ...job,
    source_sites: site
      ? { normalized_domain: site.normalized_domain, genre: site.genre, tags: site.tags }
      : null
  })
}

export async function claimQueuedJob(workerId: string) {
  return withWriteLock(async db => {
    const nowMs = Date.now()
    const queued = [...db.crawl_runs]
      .filter(run => run.status === 'queued')
      .filter(run => !run.run_after || new Date(run.run_after).getTime() <= nowMs)
      .sort((a, b) => new Date(a.queued_at).getTime() - new Date(b.queued_at).getTime())[0]

    if (!queued) return null

    queued.status = 'claimed'
    queued.worker_id = workerId
    queued.started_at = now()

    const site = db.source_sites.find(row => row.id === queued.site_id)
    return clone({ ...queued, source_sites: site || null })
  })
}

export async function updateCrawlRun(jobId: string, patch: Partial<CrawlRunRow>) {
  return withWriteLock(async db => {
    const job = db.crawl_runs.find(row => row.id === jobId)
    if (!job) return null
    Object.assign(job, patch)
    return clone(job)
  })
}

export async function failCrawlRun(jobId: string, code: string, message: string) {
  return updateCrawlRun(jobId, {
    status: 'failed',
    error_code: code,
    error_message: message,
    finished_at: now()
  })
}

export async function createSourcePage(input: Omit<SourcePageRow, 'id' | 'created_at'>) {
  return withWriteLock(async db => {
    const row = {
      ...input,
      id: randomUUID(),
      created_at: now()
    } as SourcePageRow
    db.source_pages.push(row)
    return clone(row)
  })
}

export async function insertPageAssets(records: JsonObject[]) {
  return withWriteLock(async db => {
    for (const record of records) {
      db.page_assets.push({ id: randomUUID(), created_at: now(), ...record })
    }
    return records.length
  })
}

export async function createSourceSection(input: Omit<SourceSectionRow, 'id' | 'created_at'>) {
  return withWriteLock(async db => {
    const row = {
      ...input,
      id: randomUUID(),
      created_at: now()
    } as SourceSectionRow
    db.source_sections.push(row)
    return clone(row)
  })
}

export async function updateSourceSection(sectionId: string, patch: Partial<SourceSectionRow>) {
  return withWriteLock(async db => {
    const idx = db.source_sections.findIndex((s: SourceSectionRow) => s.id === sectionId)
    if (idx === -1) return null
    Object.assign(db.source_sections[idx], patch)
    return clone(db.source_sections[idx])
  })
}

export async function getPageByCrawlRun(crawlRunId: string) {
  const db = await readDb()
  const row = db.source_pages.find(page => page.crawl_run_id === crawlRunId)
  return row ? clone(row) : null
}

export async function getPagesByCrawlRun(crawlRunId: string) {
  const db = await readDb()
  return db.source_pages
    .filter(page => page.crawl_run_id === crawlRunId)
    .map(clone)
}

export async function getPageById(pageId: string) {
  const db = await readDb()
  const row = db.source_pages.find(page => page.id === pageId)
  return row ? clone(row) : null
}

export async function getPageByUrl(url: string) {
  const db = await readDb()
  const row = db.source_pages.find(page => page.url === url)
  return row ? clone(row) : null
}

export async function getSectionsByPage(pageId: string) {
  const db = await readDb()
  const page = db.source_pages.find(row => row.id === pageId)

  return db.source_sections
    .filter(section => section.page_id === pageId)
    .sort((a, b) => a.order_index - b.order_index)
    .map(section => clone({
      ...section,
      source_pages: page ? { url: page.url, title: page.title || '' } : null
    }))
}

export async function getSection(sectionId: string) {
  const db = await readDb()
  const row = db.source_sections.find(section => section.id === sectionId)
  return row ? clone(row) : null
}

export async function getLatestResolvedSnapshot(sectionId: string) {
  const db = await readDb()
  const row = db.section_dom_snapshots
    .filter(snapshot => snapshot.section_id === sectionId && snapshot.snapshot_type === 'resolved')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
  return row ? clone(row) : null
}

export async function createSectionDomSnapshot(input: Omit<SectionDomSnapshotRow, 'id' | 'created_at'>) {
  return withWriteLock(async db => {
    const row = {
      ...input,
      id: randomUUID(),
      created_at: now()
    } as SectionDomSnapshotRow
    db.section_dom_snapshots.push(row)
    return clone(row)
  })
}

export async function insertSectionNodes(records: Array<Omit<SectionNodeRow, 'id' | 'created_at'>>) {
  return withWriteLock(async db => {
    const created = records.map(record => {
      const row = {
        ...record,
        id: randomUUID(),
        created_at: now()
      } as SectionNodeRow
      db.section_nodes.push(row)
      return row
    })
    return clone(created)
  })
}

export async function getSectionNodes(snapshotId: string) {
  const db = await readDb()
  return clone(
    db.section_nodes
      .filter(node => node.snapshot_id === snapshotId)
      .sort((a, b) => a.order_index - b.order_index)
  )
}

export async function listLibrarySections(filters: {
  genre?: string | null
  family?: string | null
  industry?: string | null
  limit: number
  q?: string | null
  sort?: string | null
  hasCta?: boolean
  hasForm?: boolean
  hasImages?: boolean
}) {
  const db = await readDb()
  const searchTerm = String(filters.q || '').trim().toLowerCase()

  const sitesById = new Map(db.source_sites.map(s => [s.id, s]))
  const pagesById = new Map(db.source_pages.map(p => [p.id, p]))

  let sections = db.source_sections.map(section => {
    const site = sitesById.get(section.site_id)
    const page = pagesById.get(section.page_id)
    return {
      ...section,
      source_sites: site
        ? {
            normalized_domain: site.normalized_domain,
            genre: site.genre,
            tags: site.tags,
            industry: site.industry
          }
        : null,
      source_pages: page ? { url: page.url, title: page.title || '' } : null
    }
  })

  if (filters.genre) sections = sections.filter(section => section.source_sites?.genre === filters.genre)
  if (filters.family) sections = sections.filter(section => section.block_family === filters.family)
  if (filters.industry) sections = sections.filter(section => section.source_sites?.industry === filters.industry)
  if (filters.hasCta) sections = sections.filter(section => section.features_jsonb?.hasCTA)
  if (filters.hasForm) sections = sections.filter(section => section.features_jsonb?.hasForm)
  if (filters.hasImages) sections = sections.filter(section => section.features_jsonb?.hasImages)

  if (searchTerm) {
    sections = sections.filter(section => {
      const searchable = [
        section.block_family,
        section.block_variant,
        section.text_summary,
        section.source_sites?.normalized_domain,
        section.source_sites?.genre,
        ...(section.source_sites?.tags || []),
        section.source_pages?.title,
        section.source_pages?.url
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return searchable.includes(searchTerm)
    })
  }

  const sortKey = filters.sort || 'newest'
  sections.sort((a, b) => {
    switch (sortKey) {
      case 'confidence':
        return (b.classifier_confidence || 0) - (a.classifier_confidence || 0)
      case 'family':
        return String(a.block_family || '').localeCompare(String(b.block_family || ''))
      case 'source':
        return String(a.source_sites?.normalized_domain || '').localeCompare(String(b.source_sites?.normalized_domain || ''))
      case 'oldest':
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      case 'newest':
      default:
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    }
  })

  return clone(sections.slice(0, filters.limit))
}

export async function getGenreSummary() {
  const db = await readDb()
  const sitesById = new Map(db.source_sites.map(s => [s.id, s]))
  const counts = db.source_sections.reduce<Record<string, number>>((acc, section) => {
    const site = sitesById.get(section.site_id)
    const genre = site?.genre || 'untagged'
    acc[genre] = (acc[genre] || 0) + 1
    return acc
  }, {})

  return Object.entries(counts)
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count)
}

export async function getFamilySummary() {
  const db = await readDb()
  const counts = db.source_sections.reduce<Record<string, number>>((acc, section) => {
    const familyKey = section.block_family || 'content'
    acc[familyKey] = (acc[familyKey] || 0) + 1
    return acc
  }, {})

  return clone(
    [...db.block_families]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(family => ({ ...family, count: counts[family.key] || 0 }))
  )
}

export async function listBlockVariants(family?: string | null) {
  const db = await readDb()
  const familiesByKey = new Map(db.block_families.map(item => [item.key, item]))
  const variants = db.block_variants
    .filter(variant => !family || variant.family_key === family)
    .sort((a, b) => a.family_key.localeCompare(b.family_key))
    .map(variant => ({
      ...variant,
      block_families: (() => {
        const row = familiesByKey.get(variant.family_key)
        return row ? { label: row.label, label_ja: row.label_ja } : null
      })()
    }))

  return clone(variants)
}

export async function findBlockVariantByKey(variantKey: string) {
  const db = await readDb()
  const row = db.block_variants.find(variant => variant.variant_key === variantKey)
  return row ? clone(row) : null
}

export async function getDefaultBlockVariant() {
  const db = await readDb()
  const row = db.block_variants[0] || null
  return row ? clone(row) : null
}

export async function insertBlockInstance(record: JsonObject) {
  return withWriteLock(async db => {
    const row = { id: randomUUID(), created_at: now(), ...record }
    db.block_instances.push(row)
    return clone(row)
  })
}

export async function getBlockInstance(blockInstanceId: string) {
  const db = await readDb()
  const row = db.block_instances.find(instance => instance.id === blockInstanceId)
  return row ? clone(row) : null
}

export async function deleteSection(sectionId: string) {
  return withWriteLock(async db => {
    const snapshotIds = db.section_dom_snapshots
      .filter(snapshot => snapshot.section_id === sectionId)
      .map(snapshot => snapshot.id)
    const patchSetIds = db.section_patch_sets
      .filter(patchSet => patchSet.section_id === sectionId)
      .map(patchSet => patchSet.id)

    db.source_sections = db.source_sections.filter(section => section.id !== sectionId)
    db.section_dom_snapshots = db.section_dom_snapshots.filter(snapshot => snapshot.section_id !== sectionId)
    db.section_nodes = db.section_nodes.filter(node => !snapshotIds.includes(node.snapshot_id))
    db.block_instances = db.block_instances.filter(instance => instance.source_section_id !== sectionId)
    db.section_patch_sets = db.section_patch_sets.filter(patchSet => patchSet.section_id !== sectionId)
    db.section_patches = db.section_patches.filter(patch => !patchSetIds.includes(patch.patch_set_id))
    db.project_page_blocks = db.project_page_blocks.filter(block => block.source_section_id !== sectionId)
    return true
  })
}

export async function createPatchSet(input: {
  section_id: string
  project_id?: string | null
  base_snapshot_id: string
  label?: string | null
}) {
  return withWriteLock(async db => {
    const row: SectionPatchSetRow = {
      id: randomUUID(),
      section_id: input.section_id,
      project_id: input.project_id || null,
      base_snapshot_id: input.base_snapshot_id,
      label: input.label || null,
      created_at: now(),
      updated_at: now()
    }
    db.section_patch_sets.push(row)
    return clone(row)
  })
}

export async function getPatchSet(patchSetId: string) {
  const db = await readDb()
  const row = db.section_patch_sets.find(item => item.id === patchSetId)
  return row ? clone(row) : null
}

export async function addPatches(
  patchSetId: string,
  patches: Array<{ nodeStableKey: string; op: string; payload?: Record<string, any> }>
) {
  return withWriteLock(async db => {
    const patchSet = db.section_patch_sets.find(item => item.id === patchSetId)
    if (!patchSet) return null

    let nextIndex = db.section_patches
      .filter(item => item.patch_set_id === patchSetId)
      .reduce((max, item) => Math.max(max, item.order_index), -1) + 1

    const created = patches.map(patch => {
      const row: SectionPatchRow = {
        id: randomUUID(),
        patch_set_id: patchSetId,
        node_stable_key: patch.nodeStableKey,
        op: patch.op,
        payload_jsonb: patch.payload || {},
        order_index: nextIndex++,
        created_at: now()
      }
      db.section_patches.push(row)
      return row
    })

    patchSet.updated_at = now()
    return clone(created)
  })
}

export async function getPatches(patchSetId: string) {
  const db = await readDb()
  return clone(
    db.section_patches
      .filter(item => item.patch_set_id === patchSetId)
      .sort((a, b) => a.order_index - b.order_index)
  )
}

export async function cleanupOldData(retentionDays: number): Promise<{ deletedCrawlRuns: number; deletedPages: number; deletedSections: number; deletedSnapshots: number; deletedNodes: number; deletedStorageFiles: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  return withWriteLock(async db => {
    // Find crawl_runs older than retention period (by queued_at)
    const oldRuns = db.crawl_runs.filter(run => run.queued_at < cutoff)
    if (oldRuns.length === 0) {
      return { deletedCrawlRuns: 0, deletedPages: 0, deletedSections: 0, deletedSnapshots: 0, deletedNodes: 0, deletedStorageFiles: 0 }
    }

    const oldRunIds = new Set(oldRuns.map(run => run.id))

    // Find associated source_pages
    const oldPages = db.source_pages.filter(page => oldRunIds.has(page.crawl_run_id))
    const oldPageIds = new Set(oldPages.map(page => page.id))

    // Find associated source_sections
    const oldSections = db.source_sections.filter(section => oldPageIds.has(section.page_id))
    const oldSectionIds = new Set(oldSections.map(section => section.id))

    // Find associated snapshots
    const oldSnapshots = db.section_dom_snapshots.filter(snap => oldSectionIds.has(snap.section_id))
    const oldSnapshotIds = new Set(oldSnapshots.map(snap => snap.id))

    // Collect storage paths to delete
    const storagePaths: Array<{ bucket: string; path: string }> = []
    for (const page of oldPages) {
      if (page.final_html_path) storagePaths.push({ bucket: 'corpus-raw-html', path: page.final_html_path })
      if (page.screenshot_storage_path) storagePaths.push({ bucket: 'corpus-page-screenshots', path: page.screenshot_storage_path })
      if (page.request_log_path) storagePaths.push({ bucket: 'corpus-raw-html', path: page.request_log_path })
      if (page.css_bundle_path) storagePaths.push({ bucket: 'corpus-raw-html', path: page.css_bundle_path })
    }
    for (const section of oldSections) {
      if (section.raw_html_storage_path) storagePaths.push({ bucket: 'corpus-raw-html', path: section.raw_html_storage_path })
      if (section.sanitized_html_storage_path) storagePaths.push({ bucket: 'corpus-sanitized-html', path: section.sanitized_html_storage_path })
      if (section.thumbnail_storage_path) storagePaths.push({ bucket: 'corpus-section-thumbnails', path: section.thumbnail_storage_path })
    }
    for (const snap of oldSnapshots) {
      if (snap.html_storage_path) storagePaths.push({ bucket: 'corpus-sanitized-html', path: snap.html_storage_path })
      if (snap.dom_json_path) storagePaths.push({ bucket: 'corpus-sanitized-html', path: snap.dom_json_path })
    }

    // Delete storage files (best-effort)
    let deletedStorageFiles = 0
    for (const { bucket, path: storagePath } of storagePaths) {
      try {
        const { absolutePath } = resolveAbsoluteStoragePath(bucket, storagePath)
        await rm(absolutePath, { force: true })
        await rm(`${absolutePath}.meta.json`, { force: true })
        deletedStorageFiles++
      } catch {
        // Ignore missing files
      }
    }

    // Find patch sets for old sections
    const oldPatchSetIds = new Set(
      db.section_patch_sets
        .filter(ps => oldSectionIds.has(ps.section_id))
        .map(ps => ps.id)
    )

    // Remove records from DB
    const deletedSnapshots = oldSnapshots.length
    const deletedNodes = db.section_nodes.filter(node => oldSnapshotIds.has(node.snapshot_id)).length

    db.section_patches = db.section_patches.filter(p => !oldPatchSetIds.has(p.patch_set_id))
    db.section_patch_sets = db.section_patch_sets.filter(ps => !oldSectionIds.has(ps.section_id))
    db.section_nodes = db.section_nodes.filter(node => !oldSnapshotIds.has(node.snapshot_id))
    db.section_dom_snapshots = db.section_dom_snapshots.filter(snap => !oldSectionIds.has(snap.section_id))
    db.block_instances = db.block_instances.filter(bi => !oldSectionIds.has(bi.source_section_id))
    db.page_assets = db.page_assets.filter(pa => !oldPageIds.has(pa.page_id))
    db.source_sections = db.source_sections.filter(section => !oldPageIds.has(section.page_id))
    db.source_pages = db.source_pages.filter(page => !oldRunIds.has(page.crawl_run_id))
    db.project_page_blocks = db.project_page_blocks.filter(block => !oldSectionIds.has(block.source_section_id))
    db.crawl_runs = db.crawl_runs.filter(run => !oldRunIds.has(run.id))

    return {
      deletedCrawlRuns: oldRuns.length,
      deletedPages: oldPages.length,
      deletedSections: oldSections.length,
      deletedSnapshots,
      deletedNodes,
      deletedStorageFiles
    }
  })
}

export async function createProjectPageBlock(record: JsonObject) {
  return withWriteLock(async db => {
    const row: ProjectPageBlockRow = {
      id: randomUUID(),
      created_at: now(),
      ...record
    }
    db.project_page_blocks.push(row)
    return clone(row)
  })
}

// ============================================================
// Auto-cleanup: duplicates & garbage sections for a crawl run
// ============================================================

export async function cleanupCrawlRunSections(crawlRunId: string): Promise<{ duplicates: number; garbage: number; oversized: number }> {
  return withWriteLock(async db => {
    const pages = db.source_pages.filter(p => p.crawl_run_id === crawlRunId)
    if (pages.length === 0) return { duplicates: 0, garbage: 0, oversized: 0 }

    const siteId = pages[0].site_id
    const pageIds = new Set(pages.map(p => p.id))
    const pageSections = db.source_sections.filter(s => pageIds.has(s.page_id))
    const toRemove = new Set<string>()

    // 1. Duplicates: サイト全体の既存セクションも含めてクロスページ重複除去
    const existingSections = db.source_sections.filter(s => s.site_id === siteId && !pageIds.has(s.page_id))
    const seen = new Map<string, string>()
    for (const s of existingSections) {
      const textKey = (s.text_summary || '').replace(/\s+/g, ' ').trim().slice(0, 50)
      seen.set(`${s.block_family}::${textKey}`, s.id)
    }
    for (const s of pageSections) {
      const textKey = (s.text_summary || '').replace(/\s+/g, ' ').trim().slice(0, 50)
      const key = `${s.block_family}::${textKey}`
      if (seen.has(key)) {
        toRemove.add(s.id)
      } else {
        seen.set(key, s.id)
      }
    }
    // 1b. Navigation/Header dedup: 同一サイトでnav/headerは最初の1つだけ残す
    const singletonFamilies = ['navigation', 'footer']
    for (const family of singletonFamilies) {
      const allOfFamily = [...existingSections, ...pageSections]
        .filter(s => s.block_family === family && !toRemove.has(s.id))
      if (allOfFamily.length > 1) {
        const sorted = allOfFamily.sort((a, b) => (b.text_summary || '').length - (a.text_summary || '').length)
        for (let i = 1; i < sorted.length; i++) {
          if (pageIds.has(sorted[i].page_id)) {
            toRemove.add(sorted[i].id)
          }
        }
      }
    }
    const duplicates = toRemove.size

    // 2. Garbage: empty or whitespace-only text_summary
    for (const s of pageSections) {
      if (toRemove.has(s.id)) continue
      const text = (s.text_summary || '').replace(/\s+/g, '').trim()
      if (text.length < 5) {
        toRemove.add(s.id)
      }
    }
    const garbage = toRemove.size - duplicates

    // 3. Oversized page dumps
    for (const s of pageSections) {
      if (toRemove.has(s.id)) continue
      const f = s.features_jsonb || {}
      if ((f.cardCount || 0) > 50 || (f.linkCount || 0) > 100 || (f.headingCount || 0) > 30) {
        toRemove.add(s.id)
      }
    }
    const oversized = toRemove.size - duplicates - garbage

    if (toRemove.size === 0) return { duplicates: 0, garbage: 0, oversized: 0 }

    // Remove sections and cascade
    const snapshotIds = new Set(
      db.section_dom_snapshots.filter(snap => toRemove.has(snap.section_id)).map(snap => snap.id)
    )
    const patchSetIds = new Set(
      db.section_patch_sets.filter(ps => toRemove.has(ps.section_id)).map(ps => ps.id)
    )

    db.source_sections = db.source_sections.filter(s => !toRemove.has(s.id))
    db.section_dom_snapshots = db.section_dom_snapshots.filter(snap => !toRemove.has(snap.section_id))
    db.section_nodes = db.section_nodes.filter(node => !snapshotIds.has(node.snapshot_id))
    db.block_instances = db.block_instances.filter(bi => !toRemove.has(bi.source_section_id))
    db.section_patch_sets = db.section_patch_sets.filter(ps => !toRemove.has(ps.section_id))
    db.section_patches = db.section_patches.filter(p => !patchSetIds.has(p.patch_set_id))
    db.project_page_blocks = db.project_page_blocks.filter(b => !toRemove.has(b.source_section_id))

    return { duplicates, garbage, oversized }
  })
}

/**
 * 同一サイトの古いクロールRunのセクションを削除する。
 * 最新のcrawlRunIdのみ残し、それ以前のRunのセクション・ページ・Runを削除。
 */
export async function removeOlderCrawlSections(siteId: string, keepCrawlRunId: string): Promise<number> {
  return withWriteLock(async db => {
    const olderRuns = db.crawl_runs.filter(r => r.site_id === siteId && r.id !== keepCrawlRunId)
    if (olderRuns.length === 0) return 0

    const olderRunIds = new Set(olderRuns.map(r => r.id))
    const olderPages = db.source_pages.filter(p => olderRunIds.has(p.crawl_run_id))
    const olderPageIds = new Set(olderPages.map(p => p.id))
    const olderSections = db.source_sections.filter(s => olderPageIds.has(s.page_id))
    const olderSectionIds = new Set(olderSections.map(s => s.id))

    if (olderSectionIds.size === 0 && olderPages.length === 0) {
      // Run records only, no pages/sections
      db.crawl_runs = db.crawl_runs.filter(r => !olderRunIds.has(r.id))
      return 0
    }

    const snapshotIds = new Set(
      db.section_dom_snapshots.filter(snap => olderSectionIds.has(snap.section_id)).map(snap => snap.id)
    )
    const patchSetIds = new Set(
      db.section_patch_sets.filter(ps => olderSectionIds.has(ps.section_id)).map(ps => ps.id)
    )

    db.source_sections = db.source_sections.filter(s => !olderSectionIds.has(s.id))
    db.section_dom_snapshots = db.section_dom_snapshots.filter(snap => !olderSectionIds.has(snap.section_id))
    db.section_nodes = db.section_nodes.filter(node => !snapshotIds.has(node.snapshot_id))
    db.block_instances = db.block_instances.filter(bi => !olderSectionIds.has(bi.source_section_id))
    db.section_patch_sets = db.section_patch_sets.filter(ps => !olderSectionIds.has(ps.section_id))
    db.section_patches = db.section_patches.filter(p => !patchSetIds.has(p.patch_set_id))
    db.project_page_blocks = db.project_page_blocks.filter(b => !olderSectionIds.has(b.source_section_id))
    db.page_assets = db.page_assets.filter(pa => !olderPageIds.has(pa.page_id))
    db.source_pages = db.source_pages.filter(p => !olderPageIds.has(p.id))
    db.crawl_runs = db.crawl_runs.filter(r => !olderRunIds.has(r.id))

    return olderSections.length
  })
}

// ============================================================
// Projects CRUD
// ============================================================

export async function listProjects() {
  const db = await readDb()
  return clone(
    [...(db.projects || [])].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  )
}

export async function createProject(name: string) {
  return withWriteLock(async db => {
    if (!db.projects) db.projects = []
    const row: ProjectRow = {
      id: randomUUID(),
      name,
      canvas_json: [],
      created_at: now()
    }
    db.projects.push(row)
    return clone(row)
  })
}

export async function updateProject(projectId: string, patch: { name?: string; canvas_json?: any[] }) {
  return withWriteLock(async db => {
    if (!db.projects) db.projects = []
    const project = db.projects.find(p => p.id === projectId)
    if (!project) return null
    if (patch.name !== undefined) project.name = patch.name
    if (patch.canvas_json !== undefined) project.canvas_json = patch.canvas_json
    return clone(project)
  })
}

export async function deleteProject(projectId: string) {
  return withWriteLock(async db => {
    if (!db.projects) db.projects = []
    db.projects = db.projects.filter(p => p.id !== projectId)
    return true
  })
}
