/**
 * TSX Template Registry
 *
 * family/variant ごとの Tailwind TSX テンプレートを管理する。
 * テンプレートは CanonicalSection の contentSlots + PageTheme を受け取り、
 * 編集可能な TSX 文字列を返す。
 *
 * AI はテンプレートの「新発明」をしない。
 * 既存 variant の安全なマッピングのみ行う。
 */

import type { CanonicalSection, CanonicalContentSlot, PageTheme } from './canonical-types.js'

// ============================================================
// Template context (テンプレートが受け取るデータ)
// ============================================================
export interface TemplateContext {
  componentName: string
  section: CanonicalSection
  theme: PageTheme
  contentImportPath: string  // e.g. '../content/site-content'
}

// ============================================================
// Template function type
// ============================================================
export type TemplateFn = (ctx: TemplateContext) => string

// ============================================================
// Helper utilities for templates
// ============================================================

function getSlotValue(slots: CanonicalContentSlot[], key: string): string {
  return slots.find(s => s.key === key)?.value || ''
}

function getSlotMeta(slots: CanonicalContentSlot[], key: string): Record<string, any> {
  return slots.find(s => s.key === key)?.meta || {}
}

function hasSlot(slots: CanonicalContentSlot[], key: string): boolean {
  return slots.some(s => s.key === key)
}

function themeContainerClass(theme: PageTheme): string {
  const map = { xl: 'max-w-5xl', '2xl': 'max-w-6xl', '3xl': 'max-w-7xl' }
  return map[theme.spacing.containerWidth] || 'max-w-6xl'
}

function themeSectionPadding(theme: PageTheme): string {
  const map = { tight: 'py-12', normal: 'py-20', relaxed: 'py-28' }
  return map[theme.spacing.sectionY] || 'py-20'
}

function themeButtonClass(theme: PageTheme): string {
  const radiusMap = { md: 'rounded-md', lg: 'rounded-lg', xl: 'rounded-xl', full: 'rounded-full' }
  const radius = radiusMap[theme.buttonStyle.radius] || 'rounded-lg'

  const weightMap = {
    solid: 'bg-primary text-white hover:bg-primary/90',
    soft: 'bg-primary/10 text-primary hover:bg-primary/20',
    outline: 'border-2 border-primary text-primary hover:bg-primary/5',
  }
  const weight = weightMap[theme.buttonStyle.weight] || weightMap.solid

  return `inline-flex items-center justify-center px-6 py-3 text-sm font-semibold ${radius} ${weight} transition-colors`
}

function sectionAttrs(section: CanonicalSection): string {
  const lock = section.constraints.layoutLocked ? ' data-layout-lock="true"' : ''
  return `data-partcopy-section="${section.rawSectionId}"${lock}`
}

function escapeJsx(text: string): string {
  return text.replace(/[{}<>]/g, c => ({ '{': '&#123;', '}': '&#125;', '<': '&lt;', '>': '&gt;' }[c] || c))
}

// ============================================================
// Template definitions
// ============================================================

// --- Hero templates ---

const heroCenteredCopy: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const headline = getSlotValue(section.contentSlots, 'headline') || 'メインコピー'
  const sub = getSlotValue(section.contentSlots, 'subheadline') || 'サブコピーテキスト'
  const cta = getSlotValue(section.contentSlots, 'primaryCta') || '詳しく見る'
  const btnClass = themeButtonClass(theme)
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  return (
    <section className="${themeSectionPadding(theme)} px-6 text-center" ${sectionAttrs(section)}>
      <div className="mx-auto ${container}">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
          {content.${componentName}.headline}
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
          {content.${componentName}.subheadline}
        </p>
        <div className="mt-10 flex items-center justify-center gap-x-4">
          <a href="#" className="${btnClass}">
            {content.${componentName}.primaryCta}
          </a>
        </div>
      </div>
    </section>
  )
}
`
}

const heroSplitMedia: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const btnClass = themeButtonClass(theme)
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  return (
    <section className="${themeSectionPadding(theme)} px-6" ${sectionAttrs(section)}>
      <div className="mx-auto ${container} grid items-center gap-12 lg:grid-cols-2">
        <div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {content.${componentName}.headline}
          </h1>
          <p className="mt-6 text-lg leading-8 text-muted-foreground">
            {content.${componentName}.subheadline}
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <a href="#" className="${btnClass}">
              {content.${componentName}.primaryCta}
            </a>
          </div>
        </div>
        <div className="aspect-[4/3] overflow-hidden rounded-2xl bg-muted">
          <img src="/assets/placeholder.svg" alt="" className="h-full w-full object-cover" />
        </div>
      </div>
    </section>
  )
}
`
}

const heroWithTrust: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const btnClass = themeButtonClass(theme)
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  return (
    <section className="${themeSectionPadding(theme)} px-6 text-center" ${sectionAttrs(section)}>
      <div className="mx-auto ${container}">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
          {content.${componentName}.headline}
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
          {content.${componentName}.subheadline}
        </p>
        <div className="mt-10 flex items-center justify-center gap-x-4">
          <a href="#" className="${btnClass}">
            {content.${componentName}.primaryCta}
          </a>
        </div>
        <div className="mt-16 flex flex-wrap items-center justify-center gap-8 opacity-60">
          {(content.${componentName}.trustLogos || []).map((logo: string, i: number) => (
            <img key={i} src="/assets/placeholder.svg" alt={logo} className="h-8 w-auto" />
          ))}
        </div>
      </div>
    </section>
  )
}
`
}

// --- Feature templates ---

const featureGrid3: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const container = themeContainerClass(theme)
  const itemCount = getSlotMeta(section.contentSlots, 'items').count || 3

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  const items = content.${componentName}.items || []
  return (
    <section className="${themeSectionPadding(theme)} px-6" ${sectionAttrs(section)}>
      <div className="mx-auto ${container}">
        <h2 className="text-center text-3xl font-bold tracking-tight">
          {content.${componentName}.sectionTitle}
        </h2>
        <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item: { title: string; description: string }, i: number) => (
            <div key={i} className="rounded-xl border bg-white p-6 shadow-sm">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <span className="text-lg">✦</span>
              </div>
              <h3 className="text-lg font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
`
}

const featureAlternating: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  const items = content.${componentName}.items || []
  return (
    <section className="${themeSectionPadding(theme)} px-6" ${sectionAttrs(section)}>
      <div className="mx-auto ${container}">
        <h2 className="text-center text-3xl font-bold tracking-tight">
          {content.${componentName}.sectionTitle}
        </h2>
        <div className="mt-16 space-y-24">
          {items.map((item: { title: string; description: string }, i: number) => (
            <div key={i} className={\`grid items-center gap-12 lg:grid-cols-2 \${i % 2 === 1 ? 'lg:direction-rtl' : ''}\`}>
              <div className={i % 2 === 1 ? 'lg:order-2' : ''}>
                <h3 className="text-2xl font-bold">{item.title}</h3>
                <p className="mt-4 text-base leading-7 text-muted-foreground">{item.description}</p>
              </div>
              <div className="aspect-[4/3] overflow-hidden rounded-2xl bg-muted">
                <img src="/assets/placeholder.svg" alt="" className="h-full w-full object-cover" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
`
}

// --- CTA templates ---

const ctaCentered: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const btnClass = themeButtonClass(theme)
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  return (
    <section className="${themeSectionPadding(theme)} px-6" ${sectionAttrs(section)}>
      <div className="mx-auto ${container} rounded-3xl bg-primary/5 px-6 py-16 text-center sm:px-16">
        <h2 className="text-3xl font-bold tracking-tight">
          {content.${componentName}.headline}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-muted-foreground">
          {content.${componentName}.subheadline}
        </p>
        <div className="mt-8">
          <a href="#" className="${btnClass}">
            {content.${componentName}.primaryCta}
          </a>
        </div>
      </div>
    </section>
  )
}
`
}

// --- FAQ templates ---

const faqAccordion: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  const items = content.${componentName}.items || []
  return (
    <section className="${themeSectionPadding(theme)} px-6" ${sectionAttrs(section)}>
      <div className="mx-auto ${container} max-w-3xl">
        <h2 className="text-center text-3xl font-bold tracking-tight">
          {content.${componentName}.sectionTitle}
        </h2>
        <dl className="mt-12 divide-y">
          {items.map((item: { question: string; answer: string }, i: number) => (
            <details key={i} className="group py-6">
              <summary className="flex cursor-pointer items-center justify-between text-lg font-semibold">
                {item.question}
                <span className="ml-4 text-muted-foreground transition-transform group-open:rotate-45">+</span>
              </summary>
              <p className="mt-4 text-base leading-7 text-muted-foreground">{item.answer}</p>
            </details>
          ))}
        </dl>
      </div>
    </section>
  )
}
`
}

// --- Pricing templates ---

const pricingThreeCards: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const btnClass = themeButtonClass(theme)
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  const plans = content.${componentName}.plans || []
  return (
    <section className="${themeSectionPadding(theme)} px-6" ${sectionAttrs(section)}>
      <div className="mx-auto ${container}">
        <h2 className="text-center text-3xl font-bold tracking-tight">
          {content.${componentName}.sectionTitle}
        </h2>
        <div className="mt-12 grid gap-8 lg:grid-cols-3">
          {plans.map((plan: { name: string; price: string; features: string[]; highlighted?: boolean }, i: number) => (
            <div key={i} className={\`rounded-2xl border p-8 \${plan.highlighted ? 'border-primary ring-2 ring-primary/20 shadow-lg' : 'bg-white shadow-sm'}\`}>
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              <p className="mt-4 text-3xl font-bold">{plan.price}</p>
              <ul className="mt-8 space-y-3">
                {plan.features.map((f: string, j: number) => (
                  <li key={j} className="flex items-start gap-3 text-sm">
                    <span className="text-primary">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <a href="#" className={\`mt-8 block w-full text-center ${btnClass}\`}>
                選択する
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
`
}

// --- Contact templates ---

const contactFormFull: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const btnClass = themeButtonClass(theme)
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  return (
    <section className="${themeSectionPadding(theme)} px-6" ${sectionAttrs(section)}>
      <div className="mx-auto ${container} max-w-2xl">
        <h2 className="text-center text-3xl font-bold tracking-tight">
          {content.${componentName}.headline}
        </h2>
        <form className="mt-12 space-y-6" onSubmit={(e) => e.preventDefault()}>
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">お名前</label>
              <input type="text" className="mt-1 block w-full rounded-lg border px-4 py-2.5" />
            </div>
            <div>
              <label className="block text-sm font-medium">メールアドレス</label>
              <input type="email" className="mt-1 block w-full rounded-lg border px-4 py-2.5" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium">お問い合わせ内容</label>
            <textarea rows={5} className="mt-1 block w-full rounded-lg border px-4 py-2.5" />
          </div>
          <button type="submit" className={\`w-full ${btnClass}\`}>
            {content.${componentName}.primaryCta || '送信する'}
          </button>
        </form>
      </div>
    </section>
  )
}
`
}

// --- Footer templates ---

const footerMultiColumn: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  const columns = content.${componentName}.columns || []
  return (
    <footer className="border-t bg-muted/30 px-6 py-16" ${sectionAttrs(section)}>
      <div className="mx-auto ${container}">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {columns.map((col: { title: string; links: string[] }, i: number) => (
            <div key={i}>
              <h4 className="text-sm font-semibold uppercase tracking-wider">{col.title}</h4>
              <ul className="mt-4 space-y-2">
                {col.links.map((link: string, j: number) => (
                  <li key={j}>
                    <span className="text-sm text-muted-foreground hover:text-foreground cursor-pointer">{link}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 border-t pt-8 text-center text-sm text-muted-foreground">
          {content.${componentName}.copyright || '© 2024 All rights reserved.'}
        </div>
      </div>
    </footer>
  )
}
`
}

const footerMinimal: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  return (
    <footer className="border-t px-6 py-8" ${sectionAttrs(section)}>
      <div className="mx-auto ${container} flex flex-col items-center justify-between gap-4 sm:flex-row">
        <p className="text-sm text-muted-foreground">
          {content.${componentName}.copyright || '© 2024 All rights reserved.'}
        </p>
      </div>
    </footer>
  )
}
`
}

// --- Navigation templates ---

const navigationSimple: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const btnClass = themeButtonClass(theme)
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  return (
    <header className="sticky top-0 z-50 border-b bg-white/80 backdrop-blur" ${sectionAttrs(section)}>
      <div className="mx-auto ${container} flex h-16 items-center justify-between px-6">
        <span className="text-lg font-bold">{content.${componentName}.siteName || 'サイト名'}</span>
        <nav className="hidden gap-6 md:flex">
          {(content.${componentName}.links || []).map((link: string, i: number) => (
            <span key={i} className="text-sm text-muted-foreground hover:text-foreground cursor-pointer">{link}</span>
          ))}
        </nav>
        {content.${componentName}.ctaLabel && (
          <a href="#" className="${btnClass} hidden md:inline-flex">
            {content.${componentName}.ctaLabel}
          </a>
        )}
      </div>
    </header>
  )
}
`
}

// --- Social Proof templates ---

const socialProofTestimonials: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  const items = content.${componentName}.items || []
  return (
    <section className="${themeSectionPadding(theme)} px-6" ${sectionAttrs(section)}>
      <div className="mx-auto ${container}">
        <h2 className="text-center text-3xl font-bold tracking-tight">
          {content.${componentName}.sectionTitle}
        </h2>
        <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item: { name: string; role?: string; quote: string }, i: number) => (
            <div key={i} className="rounded-xl border bg-white p-6 shadow-sm">
              <p className="text-sm leading-6 text-muted-foreground">{item.quote}</p>
              <div className="mt-4 flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-muted" />
                <div>
                  <p className="text-sm font-semibold">{item.name}</p>
                  {item.role && <p className="text-xs text-muted-foreground">{item.role}</p>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
`
}

// --- Stats templates ---

const statsRow: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const container = themeContainerClass(theme)

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  const stats = content.${componentName}.stats || []
  return (
    <section className="${themeSectionPadding(theme)} px-6" ${sectionAttrs(section)}>
      <div className="mx-auto ${container}">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat: { value: string; label: string }, i: number) => (
            <div key={i} className="text-center">
              <p className="text-4xl font-bold tracking-tight text-primary">{stat.value}</p>
              <p className="mt-2 text-sm text-muted-foreground">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
`
}

// --- Generic fallback ---

const genericDefault: TemplateFn = (ctx) => {
  const { componentName, section, theme } = ctx
  const container = themeContainerClass(theme)
  const familyLabel = section.family.replace(/_/g, ' ')

  return `import { content } from '${ctx.contentImportPath}'

export default function ${componentName}() {
  return (
    <section className="${themeSectionPadding(theme)} px-6" ${sectionAttrs(section)}>
      <div className="mx-auto ${container}">
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">${familyLabel}</p>
          <h2 className="mt-4 text-2xl font-bold">{content.${componentName}.headline || '${componentName}'}</h2>
          <p className="mt-4 text-base leading-7 text-muted-foreground">
            このセクションはスクリーンショットと specs/sections.md を参照して実装してください。
          </p>
        </div>
      </div>
    </section>
  )
}
`
}

// ============================================================
// Registry
// ============================================================

const TEMPLATE_REGISTRY: Record<string, TemplateFn> = {
  // Hero
  'hero/centered-copy': heroCenteredCopy,
  'hero/split-media': heroSplitMedia,
  'hero/with-trust-bar': heroWithTrust,

  // Feature
  'feature/grid-3': featureGrid3,
  'feature/grid-4': featureGrid3,  // same structure, different col count handled by content
  'feature/grid-6': featureGrid3,
  'feature/alternating': featureAlternating,

  // CTA
  'cta/centered': ctaCentered,
  'cta/dual-button': ctaCentered,  // same layout, second button in content

  // FAQ
  'faq/accordion': faqAccordion,
  'faq/two-column': faqAccordion,  // fallback to accordion

  // Pricing
  'pricing/three-cards': pricingThreeCards,
  'pricing/toggle': pricingThreeCards,  // toggle is content-level

  // Contact
  'contact/form-full': contactFormFull,
  'contact/split': contactFormFull,  // fallback

  // Footer
  'footer/multi-column': footerMultiColumn,
  'footer/minimal': footerMinimal,

  // Navigation
  'navigation/simple': navigationSimple,
  'navigation/mega': navigationSimple,  // fallback

  // Social Proof
  'social-proof/testimonial-cards': socialProofTestimonials,
  'social-proof/logo-strip': socialProofTestimonials,  // fallback

  // Stats
  'stats/row': statsRow,
  'stats/with-text': statsRow,
}

// Family-level fallbacks
const FAMILY_FALLBACK: Record<string, TemplateFn> = {
  hero: heroCenteredCopy,
  feature: featureGrid3,
  cta: ctaCentered,
  faq: faqAccordion,
  pricing: pricingThreeCards,
  contact: contactFormFull,
  footer: footerMultiColumn,
  navigation: navigationSimple,
  social_proof: socialProofTestimonials,
  stats: statsRow,
}

/**
 * layoutType に対応するテンプレートを取得する。
 * マッチしない場合は family の default fallback → generic fallback の順。
 */
export function getTemplate(layoutType: string, family: string): TemplateFn {
  return TEMPLATE_REGISTRY[layoutType]
    || FAMILY_FALLBACK[family]
    || genericDefault
}

/**
 * 利用可能な全 layoutType 一覧を返す。
 */
export function listAvailableTemplates(): string[] {
  return Object.keys(TEMPLATE_REGISTRY)
}
