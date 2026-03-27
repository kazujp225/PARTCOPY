/**
 * Section Classifier - Heuristic-based.
 * Separated module for future ML replacement.
 */

export interface RawSection {
  tagName: string
  outerHTML: string
  textContent: string
  boundingBox: { x: number; y: number; width: number; height: number }
  computedStyles: Record<string, string>
  hasImages: boolean
  hasCTA: boolean
  hasForm: boolean
  headingCount: number
  linkCount: number
  cardCount: number
  childCount: number
  classNames: string
  id: string
}

interface Classification {
  type: string
  confidence: number
}

/**
 * The 17 valid block families. Any classification result MUST be one of these.
 */
const VALID_FAMILIES = [
  'navigation',
  'hero',
  'feature',
  'social_proof',
  'stats',
  'pricing',
  'faq',
  'content',
  'cta',
  'contact',
  'recruit',
  'footer',
  'news_list',
  'timeline',
  'company_profile',
  'gallery',
  'logo_cloud',
] as const

/**
 * Mapping from unknown/invalid family names to the closest valid one.
 */
const FAMILY_ALIAS_MAP: Record<string, string> = {
  nav: 'navigation',
  header: 'navigation',
  menu: 'navigation',
  banner: 'hero',
  jumbotron: 'hero',
  mainvisual: 'hero',
  firstview: 'hero',
  service: 'feature',
  services: 'feature',
  benefit: 'feature',
  benefits: 'feature',
  merit: 'feature',
  merits: 'feature',
  features: 'feature',
  testimonial: 'social_proof',
  testimonials: 'social_proof',
  review: 'social_proof',
  reviews: 'social_proof',
  voice: 'social_proof',
  case_study: 'social_proof',
  price: 'pricing',
  plan: 'pricing',
  plans: 'pricing',
  question: 'faq',
  questions: 'faq',
  article: 'content',
  section: 'content',
  form: 'contact',
  inquiry: 'contact',
  career: 'recruit',
  careers: 'recruit',
  jobs: 'recruit',
  job: 'recruit',
  blog: 'news_list',
  news: 'news_list',
  press: 'news_list',
  updates: 'news_list',
  history: 'timeline',
  about: 'company_profile',
  company: 'company_profile',
  corporate: 'company_profile',
  portfolio: 'gallery',
  works: 'gallery',
  photos: 'gallery',
  client: 'logo_cloud',
  clients: 'logo_cloud',
  partner: 'logo_cloud',
  partners: 'logo_cloud',
  trust: 'logo_cloud',
  call_to_action: 'cta',
  action: 'cta',
}

const validFamilySet = new Set<string>(VALID_FAMILIES)

/**
 * Ensures the classified type is a valid family. Maps aliases or falls back to 'content'.
 */
function ensureValidFamily(type: string): string {
  if (validFamilySet.has(type)) return type
  const mapped = FAMILY_ALIAS_MAP[type]
  if (mapped) return mapped
  return 'content'
}

/**
 * Detect if a section looks like a "page dump" (too much content for hero).
 */
function isPageDump(section: RawSection): boolean {
  return section.linkCount >= 50 || section.cardCount >= 20 || section.headingCount >= 20
}

/**
 * Check if text contains clear numerical metrics/counters patterns.
 * Stats should ONLY be classified when there are actual numeric counters.
 */
function hasNumericalMetrics(text: string): boolean {
  // Match patterns like "1,000+", "500件", "99%", "30万" etc.
  const metricPatterns = [
    /\d{1,3}(,\d{3})+/,       // Comma-separated numbers (1,000 etc.)
    /\d+\s*[%％]/,             // Percentages
    /\d+\s*[+＋]/,             // Numbers with plus
    /\d+\s*万/,                // Japanese large number
    /\d+\s*億/,                // Japanese large number
    /\d+\s*件/,                // Count suffix (件)
    /\d+\s*社/,                // Company count (社)
    /\d+\s*名/,                // Person count (名)
    /\d+\s*人/,                // Person count (人)
    /\d+\s*拠点/,              // Location count
    /\d+\s*か国/,              // Country count
    /\d+\s*年/,                // Year count
  ]
  let matchCount = 0
  for (const pattern of metricPatterns) {
    if (pattern.test(text)) matchCount++
  }
  // Require at least 2 distinct metric patterns to qualify as stats
  return matchCount >= 2
}

export function classifySection(section: RawSection, index: number, total: number): Classification {
  const result = classifySectionInternal(section, index, total)
  // Issue #6: Guarantee only valid families are output
  return { type: ensureValidFamily(result.type), confidence: result.confidence }
}

function classifySectionInternal(section: RawSection, index: number, total: number): Classification {
  const text = section.textContent.toLowerCase()
  const cls = (typeof section.classNames === 'string' ? section.classNames : '').toLowerCase()
  const id = section.id.toLowerCase()
  const tag = section.tagName.toLowerCase()
  const pos = index / Math.max(total - 1, 1)

  // ──────────────────────────────────────────────
  // Navigation (position-gated: first 15% or last 15%)
  // ──────────────────────────────────────────────
  if (tag === 'nav' || cls.includes('nav') || id.includes('nav')) {
    if (pos <= 0.15 || pos >= 0.85) {
      return { type: 'navigation', confidence: 0.95 }
    }
    // nav-like element in the middle of the page: classify as content
    return { type: 'content', confidence: 0.5 }
  }
  if (tag === 'header' || cls.includes('header') || id.includes('header')) {
    if (section.linkCount >= 3 && pos <= 0.15) {
      return { type: 'navigation', confidence: 0.9 }
    }
  }

  // ──────────────────────────────────────────────
  // Footer (position-gated: last 25%)
  // ──────────────────────────────────────────────
  if (tag === 'footer' || cls.includes('footer') || id.includes('footer')) {
    if (pos > 0.75) {
      return { type: 'footer', confidence: 0.95 }
    }
    // "footer" class in the top 75% is unusual; treat as content
    return { type: 'content', confidence: 0.4 }
  }
  if (pos > 0.85 && section.linkCount > 5) {
    return { type: 'footer', confidence: 0.7 }
  }

  // ──────────────────────────────────────────────
  // Hero (position-gated: first 25%, reject page dumps)
  // ──────────────────────────────────────────────
  if (pos < 0.25 && !isPageDump(section)) {
    if (
      cls.includes('hero') || id.includes('hero') ||
      cls.includes('jumbotron') || cls.includes('banner') ||
      cls.includes('main-visual') || cls.includes('mainvisual') ||
      cls.includes('mv') || cls.includes('kv') ||
      cls.includes('fv') || cls.includes('firstview')
    ) {
      return { type: 'hero', confidence: 0.95 }
    }
    if (section.boundingBox.height > 300 && section.hasCTA) {
      return { type: 'hero', confidence: 0.8 }
    }
    if (pos < 0.15 && section.headingCount >= 1 && section.hasImages) {
      return { type: 'hero', confidence: 0.7 }
    }
  }
  // Page dump sections with hero class/id should be feature or content, not hero
  if (isPageDump(section) && (cls.includes('hero') || id.includes('hero'))) {
    return { type: 'feature', confidence: 0.6 }
  }

  // ──────────────────────────────────────────────
  // FAQ
  // ──────────────────────────────────────────────
  if (cls.includes('faq') || id.includes('faq') ||
    text.includes('よくある質問') || text.includes('faq') ||
    text.includes('frequently asked')) {
    return { type: 'faq', confidence: 0.9 }
  }

  // ──────────────────────────────────────────────
  // Pricing
  // ──────────────────────────────────────────────
  if (cls.includes('pricing') || id.includes('pricing') ||
    cls.includes('plan') || id.includes('plan') ||
    text.includes('料金') || text.includes('プラン') || text.includes('pricing')) {
    if (section.cardCount >= 2) return { type: 'pricing', confidence: 0.9 }
    return { type: 'pricing', confidence: 0.75 }
  }

  // ──────────────────────────────────────────────
  // Contact / Form (with "contact vs cta" refinement)
  // ──────────────────────────────────────────────
  if (section.hasForm || cls.includes('contact') || id.includes('contact') ||
    text.includes('お問い合わせ') || text.includes('contact')) {
    // Issue #5: If no form AND short text => cta, not contact
    if (!section.hasForm && section.textContent.length < 100) {
      return { type: 'cta', confidence: 0.75 }
    }
    return { type: 'contact', confidence: 0.85 }
  }

  // ──────────────────────────────────────────────
  // Social proof / Testimonial
  // ──────────────────────────────────────────────
  if (cls.includes('testimonial') || cls.includes('voice') || cls.includes('review') ||
    id.includes('testimonial') || id.includes('voice') ||
    text.includes('お客様の声') || text.includes('testimonial') ||
    text.includes('導入事例') || text.includes('お客さまの声')) {
    return { type: 'social_proof', confidence: 0.85 }
  }

  // ──────────────────────────────────────────────
  // Logo cloud / Trust
  // ──────────────────────────────────────────────
  if (cls.includes('logo') || cls.includes('client') || cls.includes('partner') ||
    cls.includes('trust') || id.includes('logo') ||
    text.includes('導入企業') || text.includes('取引先')) {
    if (section.hasImages) return { type: 'logo_cloud', confidence: 0.8 }
  }

  // ──────────────────────────────────────────────
  // Stats - ONLY when clear numerical metrics are present
  // ──────────────────────────────────────────────
  if (cls.includes('number') || cls.includes('stat') || cls.includes('counter') ||
    cls.includes('achievement') || text.includes('実績')) {
    // Issue #1: Require actual numerical metrics to classify as stats.
    // Service/feature descriptions mentioning "実績" are not stats.
    if (hasNumericalMetrics(section.textContent)) {
      return { type: 'stats', confidence: 0.80 }
    }
    // No clear numerical metrics: check for service/feature signals
    if (cls.includes('service') || cls.includes('feature') || cls.includes('merit') ||
      text.includes('サービス') || text.includes('特徴') || section.cardCount >= 2) {
      return { type: 'feature', confidence: 0.65 }
    }
    // Company overview keywords
    if (cls.includes('company') || cls.includes('about') ||
      text.includes('会社') || text.includes('企業') || text.includes('代表')) {
      return { type: 'company_profile', confidence: 0.6 }
    }
    // Fall through to further classification instead of blindly returning stats
  }

  // ──────────────────────────────────────────────
  // Recruit
  // ──────────────────────────────────────────────
  if (cls.includes('recruit') || cls.includes('career') || id.includes('recruit') ||
    text.includes('採用') || text.includes('求人') || text.includes('career')) {
    return { type: 'recruit', confidence: 0.8 }
  }

  // ──────────────────────────────────────────────
  // News
  // ──────────────────────────────────────────────
  if (cls.includes('news') || cls.includes('blog') || id.includes('news') ||
    text.includes('お知らせ') || text.includes('ニュース')) {
    return { type: 'news_list', confidence: 0.8 }
  }

  // ──────────────────────────────────────────────
  // Company profile
  // ──────────────────────────────────────────────
  if (cls.includes('company') || cls.includes('about') || id.includes('company') ||
    text.includes('会社概要') || text.includes('代表挨拶')) {
    return { type: 'company_profile', confidence: 0.75 }
  }

  // ──────────────────────────────────────────────
  // CTA
  // ──────────────────────────────────────────────
  if (cls.includes('cta') || id.includes('cta') ||
    (section.hasCTA && section.headingCount <= 2 && section.childCount < 10)) {
    return { type: 'cta', confidence: 0.8 }
  }

  // ──────────────────────────────────────────────
  // Feature
  // ──────────────────────────────────────────────
  if (cls.includes('feature') || cls.includes('service') || cls.includes('merit') ||
    cls.includes('benefit') || id.includes('feature') || id.includes('service') ||
    text.includes('特徴') || text.includes('サービス') || text.includes('feature')) {
    if (section.cardCount >= 2) return { type: 'feature', confidence: 0.85 }
    return { type: 'feature', confidence: 0.7 }
  }

  // ──────────────────────────────────────────────
  // Gallery
  // ──────────────────────────────────────────────
  if (cls.includes('gallery') || cls.includes('portfolio') || cls.includes('works') ||
    id.includes('gallery') || id.includes('works')) {
    return { type: 'gallery', confidence: 0.8 }
  }

  // ──────────────────────────────────────────────
  // Cards-based feature detection
  // ──────────────────────────────────────────────
  if (section.cardCount >= 3) {
    return { type: 'feature', confidence: 0.6 }
  }

  // ──────────────────────────────────────────────
  // Generic content with sub-type refinement (Issue #4)
  // ──────────────────────────────────────────────
  if (section.headingCount >= 1 && section.textContent.length > 100) {
    const refined = refineContent(section, text, cls, id)
    return refined
  }

  // Final fallback: attempt refinement for short/minimal sections
  return refineContent(section, text, cls, id)
}

/**
 * Issue #4: Refine "content" into more specific families based on patterns.
 */
function refineContent(
  section: RawSection,
  text: string,
  cls: string,
  id: string
): Classification {
  // Q&A / Accordion patterns => faq
  if (
    cls.includes('accordion') || cls.includes('toggle') || cls.includes('collapse') ||
    id.includes('accordion') ||
    text.includes('q.') || text.includes('a.') ||
    /q[\s.:：].*a[\s.:：]/i.test(text) ||
    (text.includes('質問') && text.includes('回答')) ||
    (text.includes('question') && text.includes('answer'))
  ) {
    return { type: 'faq', confidence: 0.65 }
  }

  // Price/plan mentions => pricing
  if (
    text.includes('price') || text.includes('pricing') ||
    text.includes('料金') || text.includes('プラン') ||
    text.includes('月額') || text.includes('年額') ||
    text.includes('cost') || text.includes('¥') || text.includes('＄')
  ) {
    return { type: 'pricing', confidence: 0.6 }
  }

  // Contact form => contact
  if (section.hasForm) {
    return { type: 'contact', confidence: 0.6 }
  }

  // Many images in grid-like layout => gallery
  if (section.hasImages && section.cardCount >= 4 && section.headingCount <= 2) {
    return { type: 'gallery', confidence: 0.55 }
  }

  // Company info keywords => company_profile
  if (
    text.includes('会社概要') || text.includes('企業情報') ||
    text.includes('代表取締役') || text.includes('設立') ||
    text.includes('資本金') || text.includes('所在地') ||
    text.includes('about us') || text.includes('our company') ||
    text.includes('company overview') || text.includes('代表挨拶') ||
    text.includes('corporate profile')
  ) {
    return { type: 'company_profile', confidence: 0.6 }
  }

  return { type: 'content', confidence: 0.5 }
}
