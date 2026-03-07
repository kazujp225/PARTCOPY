export type BlockType =
  | 'hero'
  | 'navigation'
  | 'feature'
  | 'cta'
  | 'pricing'
  | 'testimonial'
  | 'faq'
  | 'footer'
  | 'contact'
  | 'gallery'
  | 'stats'
  | 'logo-cloud'
  | 'content'
  | 'unknown'

export interface ExtractedBlock {
  id: string
  type: BlockType
  confidence: number
  html: string
  css: string
  stylesheetUrls: string[]
  textContent: string
  tagName: string
  position: { top: number; left: number; width: number; height: number }
  meta: {
    hasImages: boolean
    hasCTA: boolean
    hasForm: boolean
    headingCount: number
    linkCount: number
    cardCount: number
  }
  sourceUrl: string
  thumbnail?: string
  genre: string
  tags: string[]
}

export interface SavedPart {
  id: string
  type: string
  confidence: number
  html: string
  textContent: string
  tagName: string
  thumbnail?: string
  genre: string
  tags: string[]
  meta: Record<string, any>
  sourceUrl: string
  savedAt: string
}

export interface CanvasBlock {
  id: string
  blockId: string
  order: number
}

export interface GenreInfo {
  genre: string
  count: number
}
