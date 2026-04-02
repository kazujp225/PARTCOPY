/**
 * TSX Generator
 *
 * CanonicalSection + PageTheme → TSX/Tailwind ファイルを生成する。
 * テンプレートレジストリから適切なテンプレートを取得し、
 * contentSlots の情報を流し込む。
 */

import type { CanonicalSection, PageTheme } from './canonical-types.js'
import { DEFAULT_PAGE_THEME } from './canonical-types.js'
import { getTemplate, type TemplateContext } from './tsx-template-registry.js'

// ============================================================
// Content file generation
// ============================================================

/**
 * 全セクションの contentSlots から site-content.ts の中身を生成する。
 * ユーザーが文言差し替えする際の中心ファイル。
 */
export function generateSiteContent(
  sections: { componentName: string; section: CanonicalSection }[]
): string {
  const entries: string[] = []

  for (const { componentName, section } of sections) {
    const obj = buildContentObject(componentName, section)
    entries.push(`  ${componentName}: ${JSON.stringify(obj, null, 4).replace(/\n/g, '\n  ')},`)
  }

  return `/**
 * site-content.ts
 * 文言・コンテンツの一元管理ファイル。
 * テキスト変更はこのファイルを編集してください。
 * 画像パスもここで管理します。
 */

export const content: Record<string, any> = {
${entries.join('\n\n')}
}
`
}

function buildContentObject(componentName: string, section: CanonicalSection): Record<string, any> {
  const obj: Record<string, any> = {}
  const { family, slots, contentSlots } = section

  // Map contentSlots to content object
  for (const slot of contentSlots) {
    switch (slot.kind) {
      case 'heading':
        obj[slot.key] = slot.value || `${slot.key}のテキスト`
        break
      case 'text':
        obj[slot.key] = slot.value || `${slot.key}のテキスト`
        break
      case 'button':
        obj[slot.key] = slot.value || 'ボタンテキスト'
        break
      case 'image':
        obj[slot.key] = '/assets/placeholder.svg'
        break
      case 'list':
        obj[slot.key] = generateDefaultItems(family, slot.meta?.count as number || 3)
        break
      case 'form':
        // Forms are handled in template
        break
      case 'stat':
        obj[slot.key] = generateDefaultStats(slot.meta?.count as number || 4)
        break
      case 'badge':
        obj[slot.key] = slot.value || 'バッジ'
        break
    }
  }

  // Family-specific content augmentation
  switch (family) {
    case 'hero':
      if (!obj.headline) obj.headline = slots.headline || 'メインコピー'
      if (!obj.subheadline) obj.subheadline = slots.subheadline || 'サブコピーテキストをここに入れてください'
      if (!obj.primaryCta) obj.primaryCta = slots.primaryCta || '詳しく見る'
      break
    case 'feature':
      if (!obj.sectionTitle) obj.sectionTitle = slots.sectionTitle || '特徴・サービス'
      if (!obj.items) obj.items = generateDefaultItems('feature', slots.itemCount || 3)
      break
    case 'cta':
      if (!obj.headline) obj.headline = slots.headline || '今すぐ始めましょう'
      if (!obj.primaryCta) obj.primaryCta = slots.primaryCta || 'お問い合わせ'
      break
    case 'faq':
      if (!obj.sectionTitle) obj.sectionTitle = slots.sectionTitle || 'よくある質問'
      if (!obj.items) obj.items = generateDefaultFaqItems(slots.itemCount || 5)
      break
    case 'pricing':
      if (!obj.sectionTitle) obj.sectionTitle = slots.sectionTitle || '料金プラン'
      if (!obj.plans) obj.plans = generateDefaultPlans(slots.planCount || 3)
      break
    case 'contact':
      if (!obj.headline) obj.headline = slots.headline || 'お問い合わせ'
      if (!obj.primaryCta) obj.primaryCta = slots.primaryCta || '送信する'
      break
    case 'footer':
      if (!obj.columns) obj.columns = generateDefaultFooterColumns()
      if (!obj.copyright) obj.copyright = '© 2024 All rights reserved.'
      break
    case 'navigation':
      if (!obj.siteName) obj.siteName = 'サイト名'
      if (!obj.links) obj.links = ['サービス', '料金', '事例', '会社概要']
      if (slots.hasCTA) obj.ctaLabel = slots.primaryCta || 'お問い合わせ'
      break
    case 'social_proof':
      if (!obj.sectionTitle) obj.sectionTitle = slots.sectionTitle || 'お客様の声'
      if (!obj.items) obj.items = generateDefaultTestimonials(3)
      break
    case 'stats':
      if (!obj.stats) obj.stats = generateDefaultStats(slots.stats || 4)
      break
  }

  return obj
}

function generateDefaultItems(family: string, count: number) {
  return Array.from({ length: Math.min(count, 6) }, (_, i) => ({
    title: `項目 ${i + 1}`,
    description: 'ここに説明テキストを入れてください。',
  }))
}

function generateDefaultFaqItems(count: number) {
  return Array.from({ length: Math.min(count, 10) }, (_, i) => ({
    question: `質問 ${i + 1} のテキスト`,
    answer: 'ここに回答テキストを入れてください。',
  }))
}

function generateDefaultPlans(count: number) {
  const names = ['ベーシック', 'スタンダード', 'プレミアム']
  const prices = ['¥9,800/月', '¥19,800/月', '¥39,800/月']
  return Array.from({ length: Math.min(count, 4) }, (_, i) => ({
    name: names[i] || `プラン ${i + 1}`,
    price: prices[i] || `¥${(i + 1) * 10000}/月`,
    features: ['機能1', '機能2', '機能3'],
    highlighted: i === 1,
  }))
}

function generateDefaultTestimonials(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `お客様 ${i + 1}`,
    role: '役職名',
    quote: 'お客様の声をここに入れてください。',
  }))
}

function generateDefaultStats(count: number) {
  return Array.from({ length: Math.min(count, 6) }, (_, i) => ({
    value: `${(i + 1) * 100}+`,
    label: `指標 ${i + 1}`,
  }))
}

function generateDefaultFooterColumns() {
  return [
    { title: 'サービス', links: ['機能一覧', '料金', '事例'] },
    { title: '会社情報', links: ['会社概要', '採用情報', 'ブログ'] },
    { title: 'サポート', links: ['ヘルプ', 'お問い合わせ', 'プライバシーポリシー'] },
  ]
}

// ============================================================
// TSX component generation
// ============================================================

/**
 * 1 セクション分の TSX ファイル内容を生成する。
 */
export function generateSectionTsx(
  componentName: string,
  section: CanonicalSection,
  theme: PageTheme = DEFAULT_PAGE_THEME
): string {
  const template = getTemplate(section.layoutType, section.family)

  const ctx: TemplateContext = {
    componentName,
    section,
    theme,
    contentImportPath: '../content/site-content',
  }

  return template(ctx)
}

// ============================================================
// Theme CSS generation
// ============================================================

/**
 * PageTheme から theme.tokens.ts の中身を生成する。
 */
export function generateThemeTokens(theme: PageTheme): string {
  const colors = Object.entries(theme.colorTokens)
    .map(([k, v]) => `  '${k}': '${v}',`)
    .join('\n')

  return `/**
 * theme.tokens.ts
 * 色・フォント・余白などの統一トークン。
 * ブランドに合わせてここを調整してください。
 */

export const themeTokens = {
  colors: {
${colors}
  },
  typography: {
    bodyFont: '${theme.typography.bodyFont}',
    headingFont: '${theme.typography.headingFont}',
    scale: '${theme.typography.scale}',
  },
  spacing: {
    sectionY: '${theme.spacing.sectionY}',
    containerWidth: '${theme.spacing.containerWidth}',
  },
  buttonStyle: {
    radius: '${theme.buttonStyle.radius}',
    weight: '${theme.buttonStyle.weight}',
  },
} as const
`
}

/**
 * PageTheme から theme.css を生成する。
 * Tailwind のカスタムプロパティとして注入する。
 */
export function generateThemeCss(theme: PageTheme): string {
  const vars = Object.entries(theme.colorTokens)
    .map(([k, v]) => `  --color-${k}: ${v};`)
    .join('\n')

  return `/* Generated by PARTCOPY - theme.css */
@import 'tailwindcss';

@theme {
${vars}
  --font-body: ${theme.typography.bodyFont};
  --font-heading: ${theme.typography.headingFont};
}

:root {
  color-scheme: light;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  min-width: 320px;
  font-family: var(--font-body);
  color: var(--color-foreground);
  background: var(--color-background);
}
`
}

// ============================================================
// SectionShell component
// ============================================================

export function generateSectionShell(): string {
  return `import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  className?: string
}

/**
 * 全セクション共通のラッパー。
 * data-partcopy-section はセクション側で付与済み。
 */
export default function SectionShell({ children, className = '' }: Props) {
  return (
    <div className={className}>
      {children}
    </div>
  )
}
`
}
