/**
 * Design Token Extraction & CSS Sophistication Analysis
 * Extracts colors and fonts from CSS for brand customization.
 * Analyzes CSS sophistication to score design quality.
 */

/**
 * Analyze CSS text and return a sophistication score (0-100).
 * Measures how "polished" the design is based on CSS techniques used.
 */
export function analyzeCssSophistication(css: string, html?: string): {
  score: number
  signals: Record<string, number>
} {
  if (!css || css.length < 50) return { score: 0, signals: {} }

  const count = (pattern: RegExp) => {
    const matches = css.match(pattern)
    return matches ? matches.length : 0
  }

  const rawSignals: Record<string, number> = {
    gradient: count(/gradient/gi),
    shadow: count(/box-shadow/gi),
    radius: count(/border-radius/gi),
    transition: count(/transition(?!-)/gi),
    animation: count(/(animation|@keyframes)/gi),
    fontFace: count(/@font-face/gi),
    flex: count(/display:\s*flex/gi),
    grid: count(/display:\s*grid/gi),
    media: count(/@media/gi),
    colors: new Set(css.match(/#[0-9a-fA-F]{3,8}/g) || []).size,
    transform: count(/transform/gi),
    opacity: count(/opacity/gi),
  }

  if (html) {
    rawSignals.svg = (html.match(/<svg/gi) || []).length
  }

  // Cap each signal at 10 to prevent a single feature from dominating
  const cappedTotal = Object.values(rawSignals).reduce(
    (sum, v) => sum + Math.min(v, 10), 0
  )
  // Max possible = 13 signals * 10 = 130
  const score = Math.round(Math.min(cappedTotal / 130 * 100, 100))

  return { score, signals: rawSignals }
}

export function extractColorsFromCss(css: string): string[] {
  const colorCounts = new Map<string, number>()

  const hexRe = /#(?:[0-9a-fA-F]{3,4}){1,2}\b/g
  let m: RegExpExecArray | null
  while ((m = hexRe.exec(css)) !== null) {
    const color = m[0].toLowerCase()
    if (color !== '#fff' && color !== '#ffffff' && color !== '#000' && color !== '#000000'
      && color !== '#333' && color !== '#333333' && color !== '#ccc' && color !== '#cccccc') {
      colorCounts.set(color, (colorCounts.get(color) || 0) + 1)
    }
  }

  const rgbRe = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/gi
  while ((m = rgbRe.exec(css)) !== null) {
    const color = m[0].toLowerCase().replace(/\s+/g, '')
    colorCounts.set(color, (colorCounts.get(color) || 0) + 1)
  }

  return [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([color]) => color)
    .slice(0, 20)
}

export function extractFontsFromCss(css: string): string[] {
  const fontCounts = new Map<string, number>()
  const generics = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial', 'unset'])

  const fontRe = /font-family\s*:\s*([^;{}]+)/gi
  let m: RegExpExecArray | null
  while ((m = fontRe.exec(css)) !== null) {
    const families = m[1].split(',').map(f => f.trim().replace(/^['"]|['"]$/g, ''))
    for (const family of families) {
      if (family && !generics.has(family.toLowerCase())) {
        fontCounts.set(family, (fontCounts.get(family) || 0) + 1)
      }
    }
  }

  return [...fontCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([font]) => font)
    .slice(0, 10)
}

export function generateDesignTokensCss(colors: string[], fonts: string[]): string {
  // Use extracted colors but ensure we always have sensible defaults
  const primary = colors[0] || '#2563eb'
  const secondary = colors[1] || '#64748b'
  const accent = colors[2] || '#f59e0b'

  // Use most frequent font, fallback to system font
  const headingFont = fonts[0] ? `'${fonts[0]}'` : "'Noto Sans JP'"
  const bodyFont = fonts[1] || fonts[0] ? `'${fonts[1] || fonts[0]}'` : "'Noto Sans JP'"

  return `/* ================================================
 * デザイントークン（ブランドカスタマイズ用）
 * ================================================
 * このファイルの変数を変更するだけで、サイト全体の
 * 色・フォント・余白が自動的に統一されます。
 * brand-override（index.css内）が全セクションに強制適用します。
 *
 * 先方のClaudeへ: ここの値を自社ブランドに差し替えるだけでOK。
 * ================================================ */

:root {
  /* === メインカラー（ボタン・リンク・アクセント） === */
  --brand-primary: ${primary};
  --brand-secondary: ${secondary};
  --brand-accent: ${accent};

  /* === 背景・テキスト === */
  --brand-bg: #ffffff;
  --brand-text: #333333;
  --brand-border: #e0e0e0;

  /* === フォント === */
  --font-heading: ${headingFont}, 'Hiragino Kaku Gothic ProN', sans-serif;
  --font-body: ${bodyFont}, 'Hiragino Kaku Gothic ProN', sans-serif;

  /* === 装飾 === */
  --brand-radius: 8px;
}
`
}

/**
 * Generate a CSS override layer that forces visual unity across all sections.
 * Level 2: font family, color scheme, heading scale, section padding, container width.
 * Does NOT touch layout structure (grid, flex, cards) — preserves original design value.
 */
export function generateBrandOverrideCss(): string {
  return `/* ================================================
 * ブランド統一オーバーライド（PARTCOPY自動生成）
 * ================================================
 * フォント・配色・見出しサイズ・余白・幅を統一。
 * レイアウト構造（グリッド・カード・フレックス）は変更しない。
 * design-tokens.css の変数を変更すればサイト全体に反映される。
 * ================================================ */

/* --- フォント統一 --- */
[data-partcopy-section] {
  font-family: var(--font-body), 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif !important;
  color: var(--brand-text) !important;
}
[data-partcopy-section] h1,
[data-partcopy-section] h2,
[data-partcopy-section] h3,
[data-partcopy-section] h4,
[data-partcopy-section] h5,
[data-partcopy-section] h6 {
  font-family: var(--font-heading), 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif !important;
  color: var(--brand-text) !important;
}

/* --- 見出しサイズスケール統一 --- */
[data-partcopy-section] h1 { font-size: clamp(28px, 4vw, 48px) !important; line-height: 1.2 !important; }
[data-partcopy-section] h2 { font-size: clamp(22px, 3vw, 36px) !important; line-height: 1.3 !important; }
[data-partcopy-section] h3 { font-size: clamp(18px, 2.5vw, 28px) !important; line-height: 1.4 !important; }
[data-partcopy-section] h4 { font-size: clamp(16px, 2vw, 22px) !important; line-height: 1.4 !important; }
[data-partcopy-section] p,
[data-partcopy-section] li,
[data-partcopy-section] td,
[data-partcopy-section] th {
  font-size: clamp(14px, 1.1vw, 17px) !important;
  line-height: 1.7 !important;
}

/* --- 配色統一（リンク・ボタン） --- */
[data-partcopy-section] a {
  color: var(--brand-primary) !important;
}
[data-partcopy-section] a:hover {
  opacity: 0.8;
}
[data-partcopy-section] button,
[data-partcopy-section] [type="submit"],
[data-partcopy-section] .btn,
[data-partcopy-section] a[class*="btn"],
[data-partcopy-section] a[class*="button"],
[data-partcopy-section] a[class*="cta"] {
  background-color: var(--brand-primary) !important;
  color: #fff !important;
  border-color: var(--brand-primary) !important;
  border-radius: var(--brand-radius) !important;
}

/* --- セクション上下余白統一 --- */
[data-partcopy-section] {
  padding-top: clamp(40px, 6vw, 80px) !important;
  padding-bottom: clamp(40px, 6vw, 80px) !important;
}

/* --- コンテナ幅統一 --- */
[data-partcopy-section] > div,
[data-partcopy-section] > section,
[data-partcopy-section] > article,
[data-partcopy-section] > main {
  max-width: 1200px;
  margin-left: auto !important;
  margin-right: auto !important;
  padding-left: clamp(16px, 3vw, 40px) !important;
  padding-right: clamp(16px, 3vw, 40px) !important;
  box-sizing: border-box;
}

/* --- 背景色の交互配色（視覚リズム） --- */
.pc-preview-page > [data-partcopy-section]:nth-child(even) {
  background-color: var(--brand-bg, #ffffff);
}
.pc-preview-page > [data-partcopy-section]:nth-child(odd) {
  background-color: color-mix(in srgb, var(--brand-bg, #ffffff) 95%, var(--brand-text, #333333) 5%);
}
`
}

export function generateBrandGuide(colors: string[], fonts: string[]): string {
  const colorList = colors.slice(0, 10).map(c => `\`${c}\``).join(', ')
  const fontList = fonts.slice(0, 5).map(f => `\`${f}\``).join(', ')

  return `
## ブランドカスタマイズ（色・フォントの統一）

このサイトは複数のサイトからパーツを組み合わせているため、色やフォントがバラバラです。
以下の手順で自社ブランドに統一してください。

### 現在使われている色
${colorList || '（検出なし）'}

### 現在使われているフォント
${fontList || '（検出なし）'}

### 統一する手順

#### 方法1: design-tokens.css を使う（推奨）
\`src/design-tokens.css\` に CSS変数が定義されています。

\`\`\`
design-tokens.css の --brand-primary を自社カラーに変更して、
全コンポーネントのメインカラー（ボタン、見出し、リンク、アクセントカラー）を
この変数 var(--brand-primary) に置き換えてください。
フォントも --font-heading と --font-body を使って統一してください。
\`\`\`

#### 方法2: 直接指定
\`\`\`
サイト全体のカラーを以下に統一してください：
- メインカラー: #（自社カラーを入力）
- サブカラー: #（自社カラーを入力）
- フォント: '（自社フォントを入力）', sans-serif
各コンポーネントの CSS を修正して、色とフォントを統一してください。
コントラスト比（WCAG AA基準: 4.5:1以上）を確認してください。
\`\`\`
`
}
