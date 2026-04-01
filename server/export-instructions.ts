import * as cheerio from 'cheerio'

export const BLOCK_FAMILY_LABELS: Record<string, string> = {
  navigation: 'ナビゲーション',
  hero: 'ヒーロー',
  feature: '特徴・サービス',
  social_proof: '導入実績・信頼',
  stats: '数字・実績',
  pricing: '料金プラン',
  faq: 'よくある質問',
  content: 'コンテンツ',
  cta: 'CTA',
  contact: 'お問い合わせ',
  recruit: '採用',
  footer: 'フッター',
  news_list: 'お知らせ',
  timeline: 'タイムライン',
  company_profile: '会社概要',
  gallery: 'ギャラリー',
  logo_cloud: 'ロゴ一覧',
  section: '汎用セクション',
  CUSTOM: 'カスタム'
}

export interface ExportSectionInput {
  index: number
  sectionId: string
  blockFamily: string
  componentName: string
  domain: string
  sourceUrl?: string
  sourceTitle?: string
  screenshotFile: string
  textSummary?: string
  html: string
  css?: string
}

export interface ExportSectionSpec {
  id: string
  order: number
  blockFamily: string
  blockFamilyLabel: string
  componentName: string
  domain: string
  sourceUrl?: string
  sourceTitle?: string
  screenshotFile: string
  textSummary: string
  layout: {
    headings: number
    paragraphs: number
    images: number
    buttons: number
    links: number
    lists: number
    forms: number
  }
  sampleTexts: string[]
  headingSamples: string[]
  ctaLabels: string[]
  recreationNotes: string[]
}

function cleanText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function uniqueTexts(values: string[], limit: number) {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const cleaned = cleanText(value)
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    result.push(cleaned)
    if (result.length >= limit) break
  }

  return result
}

function familySpecificNotes(blockFamily: string) {
  const notes: Record<string, string[]> = {
    navigation: [
      '横並びのナビゲーション構造と余白のバランスを優先して再現する',
      'ロゴ領域とCTAの視線誘導を維持する'
    ],
    hero: [
      'ファーストビューの情報優先度を保つ',
      '主要CTAを視線の中心に置く'
    ],
    feature: [
      'カードや列の繰り返しルールを統一して再現する',
      'アイコンや見出しの階層を揃える'
    ],
    social_proof: [
      'ロゴや口コミなど信頼要素の並び順を再現する',
      '過度に装飾せず読みやすさを優先する'
    ],
    stats: [
      '数値の強弱と補足テキストの対比を維持する'
    ],
    pricing: [
      'プランカードの比較しやすさを最優先にする',
      '強調プランがある場合は視覚的ヒエラルキーを残す'
    ],
    faq: [
      '質問と回答の区別が一目でわかる構造にする'
    ],
    cta: [
      '行動喚起のコピーとボタンを最短距離で読ませる'
    ],
    contact: [
      '入力欄のグルーピングと送信導線を明快にする'
    ],
    footer: [
      '補助導線として整理し、情報量が多くても読めるレイアウトにする'
    ]
  }

  return notes[blockFamily] || ['スクリーンショットの余白・整列・情報密度を優先して再現する']
}

export function buildComponentName(blockFamily: string, index: number, usedNames: Set<string>) {
  const baseName = `${blockFamily || 'section'}-section`
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('') || 'Section'

  let name = `${baseName}Section`
  let suffix = 2
  while (usedNames.has(name)) {
    name = `${baseName}Section${suffix}`
    suffix++
  }
  usedNames.add(name)
  return name
}

export function buildSectionSpec(input: ExportSectionInput): ExportSectionSpec {
  const $ = cheerio.load(input.html || '')
  const textSummary = cleanText(input.textSummary || '')

  const headingSamples = uniqueTexts(
    $('h1, h2, h3')
      .toArray()
      .map((node) => $(node).text()),
    4
  )

  const sampleTexts = uniqueTexts(
    $('h1, h2, h3, p, li')
      .toArray()
      .map((node) => $(node).text())
      .filter((text) => cleanText(text).length >= 8)
      .map((text) => {
        const cleaned = cleanText(text)
        return cleaned.length > 110 ? `${cleaned.slice(0, 107)}...` : cleaned
      }),
    8
  )

  const ctaLabels = uniqueTexts(
    $('button, a, input[type="submit"], input[type="button"]')
      .toArray()
      .map((node) => {
        const text = $(node).text() || $(node).attr('value') || ''
        return cleanText(text)
      })
      .filter((text) => text.length > 0 && text.length <= 36),
    5
  )

  const layout = {
    headings: $('h1, h2, h3').length,
    paragraphs: $('p').length,
    images: $('img, picture, svg, video').length,
    buttons: $('button, input[type="submit"], input[type="button"]').length,
    links: $('a').length,
    lists: $('ul, ol').length,
    forms: $('form').length
  }

  const recreationNotes = uniqueTexts([
    ...familySpecificNotes(input.blockFamily),
    layout.forms > 0 ? 'フォームの入力体験をTailwindコンポーネントとして再構築する' : '',
    layout.images > 0 ? '画像はそのままコピーせず、プレースホルダーか差し替え前提のアセットで組む' : '',
    /background-image|linear-gradient|radial-gradient/i.test(input.css || '') ? '背景表現があるため、背景色・グラデーション・装飾要素を含めて再現する' : '',
    ctaLabels.length > 0 ? `主要CTA候補: ${ctaLabels.join(' / ')}` : '',
    headingSamples.length > 0 ? `見出しの階層感を保つ。参考見出し: ${headingSamples.join(' / ')}` : '',
    textSummary ? `要約: ${textSummary}` : ''
  ], 6)

  return {
    id: input.sectionId,
    order: input.index,
    blockFamily: input.blockFamily,
    blockFamilyLabel: BLOCK_FAMILY_LABELS[input.blockFamily] || input.blockFamily,
    componentName: input.componentName,
    domain: input.domain,
    sourceUrl: input.sourceUrl,
    sourceTitle: input.sourceTitle,
    screenshotFile: input.screenshotFile,
    textSummary,
    layout,
    sampleTexts,
    headingSamples,
    ctaLabels,
    recreationNotes
  }
}

export function buildSectionSpecsMarkdown(specs: ExportSectionSpec[]) {
  return specs.map((spec) => {
    const sourceLine = spec.sourceUrl
      ? `- 参考元: ${spec.domain} (${spec.sourceUrl})`
      : `- 参考元: ${spec.domain}`

    const layoutLine = `- 要素数: 見出し ${spec.layout.headings} / 段落 ${spec.layout.paragraphs} / 画像 ${spec.layout.images} / ボタン ${spec.layout.buttons} / リスト ${spec.layout.lists} / フォーム ${spec.layout.forms}`
    const headingLine = `- 見出しサンプル: ${spec.headingSamples.length > 0 ? spec.headingSamples.join(' | ') : 'なし'}`
    const ctaLine = `- CTA候補: ${spec.ctaLabels.length > 0 ? spec.ctaLabels.join(' | ') : 'なし'}`
    const sampleLine = `- 本文サンプル: ${spec.sampleTexts.length > 0 ? spec.sampleTexts.join(' | ') : 'なし'}`
    const notes = spec.recreationNotes.map((note) => `- ${note}`).join('\n')

    return `## ${String(spec.order).padStart(2, '0')}. ${spec.componentName}

- セクション種別: ${spec.blockFamilyLabel}
- スクリーンショット: screenshots/${spec.screenshotFile}
${sourceLine}
${layoutLine}
${headingLine}
${ctaLine}
${sampleLine}
${notes}`
  }).join('\n\n')
}

export function buildClaudeInstructions(args: {
  projectName: string
  companyName?: string
  serviceDescription?: string
  specs: ExportSectionSpec[]
}) {
  const projectName = cleanText(args.projectName) || 'PARTCOPY Export Project'
  const companyName = cleanText(args.companyName || '') || '未設定'
  const serviceDescription = cleanText(args.serviceDescription || '') || '未設定'

  const sectionTable = args.specs.map((spec) =>
    `| ${String(spec.order).padStart(2, '0')} | ${spec.componentName} | ${spec.blockFamilyLabel} | screenshots/${spec.screenshotFile} | ${spec.domain} |`
  ).join('\n')

  return `# CLAUDE.md

## Goal

このZIPは PARTCOPY のエクスポートです。元HTML/CSSの再利用は意図していません。
同梱されたスクリーンショットと指示書を参照し、Tailwindベースで見た目をゼロから再構築してください。

## Project Brief

- プロジェクト名: ${projectName}
- 会社名: ${companyName}
- サービス概要: ${serviceDescription}

## Non-Negotiables

1. 元サイトの HTML / CSS / class 名をコピーしない。
2. `screenshots/` の見た目を参考に、`specs/sections.md` の構成情報を使って Tailwind で再現する。
3. 文言・画像は参考に留め、固有名詞や著作物はそのまま流用しない。
4. レイアウト、余白、タイポグラフィ、情報階層を優先して再現する。
5. 各セクションは `src/components/` 内の対応ファイルを実装する。

## Working Order

1. `specs/sections.md` を読み、セクション順と役割を把握する。
2. `screenshots/` を見ながら `src/components/*.tsx` を順番に実装する。
3. `src/App.tsx` の並び順は変えず、LPとして自然につながるよう統一感を整える。
4. 共通トークンが必要なら `src/index.css` に追加し、Tailwind ユーティリティ中心でまとめる。

## Section Map

| 順番 | コンポーネント | 種別 | スクリーンショット | 参考ドメイン |
|---|---|---|---|---|
${sectionTable}

## Expected Output

- React + TypeScript + Vite で動作するLP
- スタイリングは Tailwind CSS 4 を使用
- 画像は `public/assets/placeholder.svg` または差し替え用アセットで仮置き
- モバイルとデスクトップで破綻しないレスポンシブ実装

## Notes

- セクション実装の補助情報は `specs/sections.json` にも入っています。
- 迷ったら「コード再利用」ではなく「スクショから再設計」を優先してください。
`
}
