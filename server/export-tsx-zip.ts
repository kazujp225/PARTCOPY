/**
 * TSX ZIP Export Service
 *
 * CanonicalSection + PageTheme → 編集可能な TSX/Tailwind プロジェクト ZIP を生成する。
 * 標準エクスポートパイプライン。
 */
import archiver from 'archiver'
import type express from 'express'

import type { CanonicalSection, PageTheme } from './canonical-types.js'
import { DEFAULT_PAGE_THEME } from './canonical-types.js'
import {
  buildComponentName,
  buildSectionSpec,
  buildSectionSpecsMarkdown,
  type ExportSectionSpec,
} from './export-instructions.js'
import { logger } from './logger.js'
import {
  generateSectionTsx,
  generateSiteContent,
  generateThemeTokens,
  generateThemeCss,
  generateSectionShell,
} from './tsx-generator.js'
import { generatePageTheme, applyStrictUnification } from './unify-theme.js'

// ============================================================
// Types
// ============================================================

export interface TsxZipExportInput {
  sections: CanonicalSection[]
  cssTexts: string[]
  htmlTexts: Map<string, string>         // rawSectionId → prepared HTML (for specs)
  screenshotBuffers: Map<string, Buffer>  // rawSectionId → PNG buffer
  projectName?: string
  companyName?: string
  serviceDescription?: string
}

// ============================================================
// Static files
// ============================================================

const PACKAGE_JSON = JSON.stringify({
  name: 'partcopy-rebuild-kit',
  private: true,
  version: '1.0.0',
  type: 'module',
  scripts: {
    dev: 'vite',
    build: 'tsc -b && vite build',
    validate: 'npx tsx scripts/validate-layout.ts'
  },
  dependencies: {
    react: '^19.2.4',
    'react-dom': '^19.2.4'
  },
  devDependencies: {
    '@types/react': '^19.2.14',
    '@types/react-dom': '^19.2.3',
    '@vitejs/plugin-react': '^6.0.1',
    '@tailwindcss/vite': '^4.1.0',
    tailwindcss: '^4.1.0',
    typescript: '^6.0.2',
    tsx: '^4.19.0',
    vite: '^8.0.3'
  }
}, null, 2)

const TSCONFIG_JSON = JSON.stringify({
  compilerOptions: {
    target: 'ES2020',
    useDefineForClassFields: true,
    lib: ['ES2020', 'DOM', 'DOM.Iterable'],
    module: 'ESNext',
    skipLibCheck: true,
    moduleResolution: 'bundler',
    allowImportingTsExtensions: true,
    isolatedModules: true,
    moduleDetection: 'force',
    noEmit: true,
    jsx: 'react-jsx',
    strict: true,
    noUnusedLocals: false,
    noUnusedParameters: false
  },
  include: ['src', 'scripts']
}, null, 2)

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
`

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480"><rect width="800" height="480" fill="#e2e8f0"/><text x="400" y="240" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="22">Replace with your own asset</text></svg>`

const SCREENSHOT_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900"><rect width="1440" height="900" fill="#f8fafc"/><rect x="48" y="48" width="1344" height="804" rx="32" fill="#e2e8f0" stroke="#cbd5e1" stroke-width="4" stroke-dasharray="12 12"/><text x="720" y="438" text-anchor="middle" fill="#475569" font-family="sans-serif" font-size="32">Screenshot unavailable</text></svg>`

// ============================================================
// CLAUDE.md for TSX export
// ============================================================

function generateClaudeMd(
  projectName: string,
  companyName: string,
  serviceDescription: string,
  componentNames: string[],
  sectionFamilies: string[]
): string {
  const sectionList = componentNames.map((name, i) =>
    `| ${String(i + 1).padStart(2, '0')} | ${name} | ${sectionFamilies[i] || 'section'} |`
  ).join('\n')

  return `# CLAUDE.md

## Goal

このプロジェクトは PARTCOPY からエクスポートされた LP テンプレートです。
Tailwind CSS + React + TypeScript で構成されています。

## Project Brief

- プロジェクト名: ${projectName}
- 会社名: ${companyName}
- サービス概要: ${serviceDescription}

## 統一化モード: strict（全セクション layoutLocked）

このエクスポートは **strict モード** で生成されています。
全セクションの \`layoutLocked\` が \`true\` です。

### 許可されている変更
- 文言の差し替え（\`src/content/site-content.ts\` 経由）
- 色・フォント・余白トークンの調整（\`src/theme/theme.tokens.ts\` 経由）
- 画像の差し替え（プレースホルダー → 実画像）
- ボタンスタイルの微調整（角丸・ウェイト）

### 禁止されている変更
- 要素の順序変更
- カラム数の変更
- 背景構造の削除や大幅変更
- 情報密度の大幅変更（セクション内の要素を大量に追加・削除）
- セクション種別の変更（hero → feature への変換など）
- スクリーンショットとの差分が大きい再設計

### その他ルール
1. 元サイトのリンクは復元しない。
2. 著作権に触れうる文言や画像は差し替える。
3. 新規下層ページを作る場合は既存 theme を継承する。
4. \`npm run validate\` でレイアウト違反がないか検証できる。

## Section Map

| 順番 | コンポーネント | 種別 |
|---|---|---|
${sectionList}

## ファイル構成

- \`src/content/site-content.ts\` — 文言の一元管理（テキスト変更はここ）
- \`src/theme/theme.tokens.ts\` — 色・フォント・余白トークン
- \`src/theme/theme.css\` — Tailwind カスタムプロパティ
- \`src/components/sections/\` — セクションコンポーネント
- \`src/components/SectionShell.tsx\` — セクション共通ラッパー
- \`specs/sections.json\` — セクション仕様（lock 情報含む）
- \`screenshots/\` — 見た目の参考スクリーンショット
- \`scripts/validate-layout.ts\` — レイアウト lock 違反検知

## 開発

\`\`\`bash
npm install
npm run dev
\`\`\`

## 検証

\`\`\`bash
npm run validate
\`\`\`
`
}

// ============================================================
// validate-layout.ts script
// ============================================================

function generateValidateScript(specs: any[]): string {
  return `/**
 * validate-layout.ts
 * レイアウト lock 違反を検知するスクリプト。
 * \`npm run validate\` で実行。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const specsPath = join(ROOT, 'specs', 'sections.json')

interface SectionSpec {
  id: string
  componentName: string
  layoutLocked: boolean
  blockFamily: string
}

function main() {
  let exitCode = 0
  const errors: string[] = []

  // 1. specs/sections.json が存在するか
  if (!existsSync(specsPath)) {
    console.error('❌ specs/sections.json not found')
    process.exit(1)
  }

  const specsData = JSON.parse(readFileSync(specsPath, 'utf-8'))
  const sections: SectionSpec[] = specsData.sections || []

  // 2. 各セクションのコンポーネントファイルが存在するか
  for (const sec of sections) {
    const componentPath = join(ROOT, 'src', 'components', 'sections', sec.componentName + '.tsx')
    if (!existsSync(componentPath)) {
      errors.push(\`❌ Missing component: src/components/sections/\${sec.componentName}.tsx\`)
      continue
    }

    const content = readFileSync(componentPath, 'utf-8')

    // 3. data-partcopy-section 属性があるか
    if (!content.includes('data-partcopy-section')) {
      errors.push(\`❌ \${sec.componentName}: missing data-partcopy-section attribute\`)
    }

    // 4. layoutLocked なセクションに data-layout-lock があるか
    if (sec.layoutLocked && !content.includes('data-layout-lock')) {
      errors.push(\`❌ \${sec.componentName}: layoutLocked but missing data-layout-lock attribute\`)
    }
  }

  // 5. App.tsx のセクション順が specs と一致するか
  const appPath = join(ROOT, 'src', 'App.tsx')
  if (existsSync(appPath)) {
    const appContent = readFileSync(appPath, 'utf-8')
    const componentOrder = sections.map(s => s.componentName)
    const appOrder: string[] = []
    for (const name of componentOrder) {
      const idx = appContent.indexOf('<' + name)
      if (idx >= 0) appOrder.push(name)
    }

    for (let i = 0; i < componentOrder.length; i++) {
      if (appOrder[i] !== componentOrder[i]) {
        errors.push(\`⚠️  Section order mismatch at position \${i + 1}: expected \${componentOrder[i]}, found \${appOrder[i] || 'missing'}\`)
        break
      }
    }
  }

  // 6. 外部リンクが残っていないか（src/components/sections/ 内）
  for (const sec of sections) {
    const componentPath = join(ROOT, 'src', 'components', 'sections', sec.componentName + '.tsx')
    if (!existsSync(componentPath)) continue
    const content = readFileSync(componentPath, 'utf-8')
    const externalLinks = content.match(/href=["']https?:\\/\\//g) || []
    if (externalLinks.length > 0) {
      errors.push(\`⚠️  \${sec.componentName}: \${externalLinks.length} external link(s) found\`)
    }
  }

  if (errors.length === 0) {
    console.log('✅ All layout validations passed')
  } else {
    for (const err of errors) {
      console.error(err)
    }
    exitCode = 1
  }

  process.exit(exitCode)
}

main()
`
}

// ============================================================
// README
// ============================================================

function generateReadme(projectName: string): string {
  return `# ${projectName}

PARTCOPY からエクスポートされた LP テンプレートです。

## セットアップ

\`\`\`bash
npm install
npm run dev
\`\`\`

## 編集ガイド

1. **文言変更**: \`src/content/site-content.ts\` を編集
2. **色・フォント**: \`src/theme/theme.tokens.ts\` を編集
3. **セクション構造**: \`src/components/sections/\` の各ファイルを編集
4. **検証**: \`npm run validate\` でレイアウト違反チェック

詳細は \`CLAUDE.md\` を参照してください。
`
}

// ============================================================
// Main export function
// ============================================================

export async function streamTsxZipExport(
  input: TsxZipExportInput,
  res: express.Response
) {
  const { sections, cssTexts, screenshotBuffers, htmlTexts } = input

  if (sections.length === 0) {
    res.status(404).json({ error: 'No sections to export' })
    return
  }

  // 1. Generate theme from sections
  const theme = generatePageTheme({ sections, cssTexts })

  // 2. Apply strict unification
  const unifiedSections = applyStrictUnification(sections, theme)

  // 3. Generate component names
  const usedNames = new Set<string>()
  const componentNames = unifiedSections.map(s =>
    buildComponentName(s.family, 0, usedNames)
  )

  // 4. Generate all files
  const projectName = (input.projectName || input.companyName || 'PARTCOPY Export').trim() || 'PARTCOPY Export'

  // Generate TSX for each section
  const sectionEntries = unifiedSections.map((section, i) => ({
    componentName: componentNames[i],
    section,
  }))

  const siteContent = generateSiteContent(sectionEntries)
  const themeTokens = generateThemeTokens(theme)
  const themeCss = generateThemeCss(theme)
  const sectionShell = generateSectionShell()

  // Build specs for sections.json
  const specsForJson = unifiedSections.map((section, i) => ({
    id: section.rawSectionId,
    order: i + 1,
    componentName: componentNames[i],
    blockFamily: section.family,
    layoutType: section.layoutType,
    layoutLocked: section.constraints.layoutLocked,
    structureSignature: section.structureSignature,
  }))

  // Build section specs for markdown (reuse existing)
  const exportSpecs = unifiedSections.map((section, i) => {
    const screenshotFile = `${String(i + 1).padStart(2, '0')}-${section.family.replace(/[^a-z0-9_-]+/gi, '-')}.png`
    return buildSectionSpec({
      index: i + 1,
      sectionId: section.rawSectionId,
      blockFamily: section.family,
      componentName: componentNames[i],
      domain: section.references.sourceDomain || 'unknown',
      sourceUrl: section.references.sourceUrl,
      screenshotFile,
      textSummary: section.slots?.headline || section.slots?.sectionTitle || '',
      html: htmlTexts.get(section.rawSectionId) || '',
      css: cssTexts[i] || '',
    })
  })
  const sectionsMarkdown = buildSectionSpecsMarkdown(exportSpecs)

  const claudeMd = generateClaudeMd(
    projectName,
    input.companyName || '未設定',
    input.serviceDescription || '未設定',
    componentNames,
    unifiedSections.map(s => s.family)
  )

  // App.tsx
  const imports = componentNames.map(name =>
    `import ${name} from './components/sections/${name}'`
  ).join('\n')
  const renders = componentNames.map(name =>
    `      <${name} />`
  ).join('\n')
  const appTsx = `${imports}

export default function App() {
  return (
    <main className="min-h-screen">
${renders}
    </main>
  )
}
`

  const indexTsx = `import ReactDOM from 'react-dom/client'
import './theme/theme.css'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
`

  const indexHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${projectName}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/index.tsx"></script>
</body>
</html>
`

  const sectionsJson = JSON.stringify({
    projectName,
    exportedAt: new Date().toISOString(),
    theme,
    sections: specsForJson,
  }, null, 2)

  const validateScript = generateValidateScript(specsForJson)
  const readmeMd = generateReadme(projectName)

  // Stream ZIP
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${projectName.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip"`)

  const archive = archiver('zip', { zlib: { level: 9 } })
  archive.on('error', (err: Error) => {
    logger.error('TSX ZIP export archiver error', { error: err.message })
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    } else {
      res.end()
    }
  })

  archive.pipe(res)

  // Root files
  archive.append(claudeMd, { name: 'CLAUDE.md' })
  archive.append(readmeMd, { name: 'README.md' })
  archive.append(PACKAGE_JSON, { name: 'package.json' })
  archive.append(TSCONFIG_JSON, { name: 'tsconfig.json' })
  archive.append(VITE_CONFIG, { name: 'vite.config.ts' })
  archive.append(indexHtml, { name: 'index.html' })

  // Specs
  archive.append(sectionsJson, { name: 'specs/sections.json' })
  archive.append(sectionsMarkdown, { name: 'specs/sections.md' })
  const pageJson = JSON.stringify({ projectName, theme }, null, 2)
  archive.append(pageJson, { name: 'specs/page.json' })

  // Scripts
  archive.append(validateScript, { name: 'scripts/validate-layout.ts' })

  // Public
  archive.append(PLACEHOLDER_SVG, { name: 'public/assets/placeholder.svg' })

  // Source files
  archive.append(indexTsx, { name: 'src/index.tsx' })
  archive.append(appTsx, { name: 'src/App.tsx' })
  archive.append(themeCss, { name: 'src/theme/theme.css' })
  archive.append(themeTokens, { name: 'src/theme/theme.tokens.ts' })
  archive.append(siteContent, { name: 'src/content/site-content.ts' })
  archive.append(sectionShell, { name: 'src/components/SectionShell.tsx' })

  // Section components
  for (let i = 0; i < unifiedSections.length; i++) {
    const tsxContent = generateSectionTsx(componentNames[i], unifiedSections[i], theme)
    archive.append(tsxContent, { name: `src/components/sections/${componentNames[i]}.tsx` })

    // Screenshots
    const screenshotFile = `${String(i + 1).padStart(2, '0')}-${unifiedSections[i].family.replace(/[^a-z0-9_-]+/gi, '-')}.png`
    const buffer = screenshotBuffers.get(unifiedSections[i].rawSectionId)
    if (buffer) {
      archive.append(buffer, { name: `screenshots/${screenshotFile}` })
    } else {
      archive.append(SCREENSHOT_PLACEHOLDER_SVG, { name: `screenshots/${screenshotFile}` })
    }
  }

  await archive.finalize()
}
