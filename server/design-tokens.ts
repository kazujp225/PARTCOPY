/**
 * Design Token Extraction
 * Extracts colors and fonts from CSS for brand customization.
 */

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
  const names = ['primary', 'secondary', 'accent', 'highlight', 'info', 'success', 'warning', 'muted']
  const colorVars = colors.slice(0, 8).map((color, i) =>
    `  --brand-${names[i] || `color-${i + 1}`}: ${color};`
  ).join('\n')

  const fontNames = ['heading', 'body', 'accent']
  const fontVars = fonts.slice(0, 3).map((font, i) =>
    `  --font-${fontNames[i] || `family-${i + 1}`}: '${font}', sans-serif;`
  ).join('\n')

  return `/* ================================================
 * デザイントークン（ブランドカスタマイズ用）
 * ================================================
 * このファイルのCSS変数を変更するだけで、
 * サイト全体の色やフォントを統一できます。
 *
 * 使い方:
 *   1. 下の変数を自社のブランドカラーに変更
 *   2. Claude Codeに「design-tokens.cssの変数を全コンポーネントに適用して」と指示
 * ================================================ */

:root {
  /* === カラーパレット === */
${colorVars || '  /* （カラーが検出されませんでした） */'}

  /* === フォント === */
${fontVars || '  /* （フォントが検出されませんでした） */'}

  /* === 基本設定 === */
  --brand-bg: #ffffff;
  --brand-text: #333333;
  --brand-border: #e0e0e0;
  --brand-radius: 8px;
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
