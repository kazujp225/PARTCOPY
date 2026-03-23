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

export function classifySection(section: RawSection, index: number, total: number): Classification {
  const text = section.textContent.toLowerCase()
  const cls = (typeof section.classNames === 'string' ? section.classNames : '').toLowerCase()
  const id = section.id.toLowerCase()
  const tag = section.tagName.toLowerCase()
  const pos = index / Math.max(total - 1, 1)

  // Navigation
  if (tag === 'nav' || cls.includes('nav') || id.includes('nav')) {
    return { type: 'navigation', confidence: 0.95 }
  }
  if (tag === 'header' || cls.includes('header') || id.includes('header')) {
    if (section.linkCount >= 3) return { type: 'navigation', confidence: 0.9 }
  }

  // Footer
  if (tag === 'footer' || cls.includes('footer') || id.includes('footer')) {
    return { type: 'footer', confidence: 0.95 }
  }
  if (pos > 0.85 && section.linkCount > 5) {
    return { type: 'footer', confidence: 0.7 }
  }

  // Hero
  if (pos < 0.25 && (
    cls.includes('hero') || id.includes('hero') ||
    cls.includes('jumbotron') || cls.includes('banner') ||
    cls.includes('main-visual') || cls.includes('mainvisual') ||
    cls.includes('mv') || cls.includes('kv') ||
    cls.includes('fv') || cls.includes('firstview')
  )) {
    return { type: 'hero', confidence: 0.95 }
  }
  if (pos < 0.2 && section.boundingBox.height > 300 && section.hasCTA) {
    return { type: 'hero', confidence: 0.8 }
  }
  if (pos < 0.15 && section.headingCount >= 1 && section.hasImages) {
    return { type: 'hero', confidence: 0.7 }
  }

  // FAQ
  if (cls.includes('faq') || id.includes('faq') ||
    text.includes('よくある質問') || text.includes('faq') ||
    text.includes('frequently asked')) {
    return { type: 'faq', confidence: 0.9 }
  }

  // Pricing
  if (cls.includes('pricing') || id.includes('pricing') ||
    cls.includes('plan') || id.includes('plan') ||
    text.includes('料金') || text.includes('プラン') || text.includes('pricing')) {
    if (section.cardCount >= 2) return { type: 'pricing', confidence: 0.9 }
    return { type: 'pricing', confidence: 0.75 }
  }

  // Contact / Form
  if (section.hasForm || cls.includes('contact') || id.includes('contact') ||
    text.includes('お問い合わせ') || text.includes('contact')) {
    return { type: 'contact', confidence: 0.85 }
  }

  // Social proof / Testimonial
  if (cls.includes('testimonial') || cls.includes('voice') || cls.includes('review') ||
    id.includes('testimonial') || id.includes('voice') ||
    text.includes('お客様の声') || text.includes('testimonial') ||
    text.includes('導入事例') || text.includes('お客さまの声')) {
    return { type: 'social_proof', confidence: 0.85 }
  }

  // Logo cloud / Trust
  if (cls.includes('logo') || cls.includes('client') || cls.includes('partner') ||
    cls.includes('trust') || id.includes('logo') ||
    text.includes('導入企業') || text.includes('取引先')) {
    if (section.hasImages) return { type: 'logo_cloud', confidence: 0.8 }
  }

  // Stats
  if (cls.includes('number') || cls.includes('stat') || cls.includes('counter') ||
    cls.includes('achievement') || text.includes('実績')) {
    return { type: 'stats', confidence: 0.75 }
  }

  // Recruit
  if (cls.includes('recruit') || cls.includes('career') || id.includes('recruit') ||
    text.includes('採用') || text.includes('求人') || text.includes('career')) {
    return { type: 'recruit', confidence: 0.8 }
  }

  // News
  if (cls.includes('news') || cls.includes('blog') || id.includes('news') ||
    text.includes('お知らせ') || text.includes('ニュース')) {
    return { type: 'news_list', confidence: 0.8 }
  }

  // Company profile
  if (cls.includes('company') || cls.includes('about') || id.includes('company') ||
    text.includes('会社概要') || text.includes('代表挨拶')) {
    return { type: 'company_profile', confidence: 0.75 }
  }

  // CTA
  if (cls.includes('cta') || id.includes('cta') ||
    (section.hasCTA && section.headingCount <= 2 && section.childCount < 10)) {
    return { type: 'cta', confidence: 0.8 }
  }

  // Feature
  if (cls.includes('feature') || cls.includes('service') || cls.includes('merit') ||
    cls.includes('benefit') || id.includes('feature') || id.includes('service') ||
    text.includes('特徴') || text.includes('サービス') || text.includes('feature')) {
    if (section.cardCount >= 2) return { type: 'feature', confidence: 0.85 }
    return { type: 'feature', confidence: 0.7 }
  }

  // Gallery
  if (cls.includes('gallery') || cls.includes('portfolio') || cls.includes('works') ||
    id.includes('gallery') || id.includes('works')) {
    return { type: 'gallery', confidence: 0.8 }
  }

  // Cards-based feature detection
  if (section.cardCount >= 3) {
    return { type: 'feature', confidence: 0.6 }
  }

  // Generic content
  if (section.headingCount >= 1 && section.textContent.length > 100) {
    return { type: 'content', confidence: 0.5 }
  }

  return { type: 'content', confidence: 0.3 }
}
