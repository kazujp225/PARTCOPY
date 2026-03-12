// ============================================================
// Block taxonomy
// ============================================================
export type BlockFamily =
  | 'navigation'
  | 'hero'
  | 'feature'
  | 'social_proof'
  | 'stats'
  | 'pricing'
  | 'faq'
  | 'content'
  | 'cta'
  | 'contact'
  | 'recruit'
  | 'footer'
  | 'news_list'
  | 'timeline'
  | 'company_profile'
  | 'gallery'
  | 'logo_cloud'

// ============================================================
// Crawl job
// ============================================================
export type JobStatus = 'queued' | 'claimed' | 'rendering' | 'parsed' | 'normalizing' | 'done' | 'failed'

export interface CrawlJob {
  id: string
  site_id: string
  status: JobStatus
  page_count: number
  section_count: number
  error_message?: string
  queued_at: string
  started_at?: string
  finished_at?: string
  source_sites?: {
    normalized_domain: string
    genre: string
    tags: string[]
  }
}

// ============================================================
// Source section (from Supabase)
// ============================================================
export interface SourceSection {
  id: string
  page_id: string
  site_id: string
  order_index: number
  tag_name: string
  bbox_json: { top: number; left: number; width: number; height: number }
  block_family: BlockFamily | string
  block_variant?: string
  classifier_type: string
  classifier_confidence: number
  features_jsonb: Record<string, any>
  text_summary: string
  thumbnail_storage_path?: string
  thumbnailUrl?: string
  htmlUrl?: string
  raw_html_storage_path?: string
  sanitized_html_storage_path?: string
  source_pages?: { url: string; title: string }
  source_sites?: { normalized_domain: string; genre: string; tags: string[]; industry?: string }
  created_at: string
}

// ============================================================
// Canvas
// ============================================================
export interface CanvasBlock {
  id: string
  sectionId: string
  position: number
}

// ============================================================
// Block family metadata
// ============================================================
export interface BlockFamilyInfo {
  key: string
  label: string
  label_ja: string
  sort_order: number
  count?: number
}

// ============================================================
// Genre info
// ============================================================
export interface GenreInfo {
  genre: string
  count: number
}
