/**
 * TSX ZIP Export Service (V2)
 *
 * Structure-preserving compiler ベース。
 * raw HTML → Structure IR → TSX + CSS Module
 * 汎用テンプレートには依存しない。
 */
import archiver from 'archiver'
import type express from 'express'

import {
  buildComponentName,
  buildSectionSpec,
  buildSectionSpecsMarkdown,
} from './export-instructions.js'
import { logger } from './logger.js'
import { compileHtmlToStructureIR } from './compile-structure-ir.js'
import { emitTsxFromIR } from './emit-tsx-from-ir.js'
import type { SectionIR } from './structure-ir.js'
import {
  collectCssAssetUrls,
  collectHtmlAssetUrls,
  rewriteHtmlAssetUrls,
  rewriteCssUrls,
} from './render-utils.js'

// ============================================================
// Types
// ============================================================

export interface TsxZipExportInput {
  sectionMetas: SectionMeta[]
  projectName?: string
  companyName?: string
  serviceDescription?: string
}

export interface SectionMeta {
  sectionId: string
  blockFamily: string
  html: string
  css: string
  scopeClass: string
  scopedCss: string
  fontFaceCss: string[]
  screenshotBuffer?: Buffer
  sourceUrl?: string
  sourceDomain?: string
  screenshotPath?: string
  textSummary?: string
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
  css: {
    modules: {
      localsConvention: 'camelCase',
    },
  },
})
`

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480"><rect width="800" height="480" fill="#e2e8f0"/><text x="400" y="240" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="22">Replace with your own asset</text></svg>`

const SCREENSHOT_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900"><rect width="1440" height="900" fill="#f8fafc"/><rect x="48" y="48" width="1344" height="804" rx="32" fill="#e2e8f0" stroke="#cbd5e1" stroke-width="4" stroke-dasharray="12 12"/><text x="720" y="438" text-anchor="middle" fill="#475569" font-family="sans-serif" font-size="32">Screenshot unavailable</text></svg>`

// ============================================================
// CLAUDE.md
// ============================================================

function generateClaudeMd(
  projectName: string,
  companyName: string,
  serviceDescription: string,
  componentNames: string[],
  families: string[]
): string {
  const rows = componentNames.map((name, i) =>
    `| ${String(i + 1).padStart(2, '0')} | ${name} | ${families[i] || 'section'} |`
  ).join('\n')

  return `# CLAUDE.md

## Goal

このプロジェクトは PARTCOPY からエクスポートされた LP テンプレートです。
元サイトの HTML 構造を保持した TSX + CSS Modules で構成されています。

## Project Brief

- プロジェクト名: ${projectName}
- 会社名: ${companyName}
- サービス概要: ${serviceDescription}

## 統一化モード: strict（全セクション layoutLocked）

全セクションの \`layoutLocked\` が \`true\` です。

### 許可されている変更
- 文言の差し替え（\`src/content/site-content.ts\` 経由）
- 色・フォントの調整（各セクションの \`.module.css\` を編集）
- 画像の差し替え（プレースホルダー → 実画像）

### 禁止されている変更
- 要素の順序変更
- カラム数の変更
- 背景構造の削除や大幅変更
- 情報密度の大幅変更
- スクリーンショットとの差分が大きい再設計

### その他ルール
1. 元サイトのリンクは復元しない。
2. 著作権に触れうる文言や画像は差し替える。
3. \`npm run validate\` でレイアウト違反をチェックできる。

## Section Map

| 順番 | コンポーネント | 種別 |
|---|---|---|
${rows}

## ファイル構成

- \`src/content/site-content.ts\` — 文言の一元管理
- \`src/components/sections/*.tsx\` — セクションコンポーネント
- \`src/components/sections/*.module.css\` — セクション固有スタイル
- \`src/theme/theme.css\` — 全体テーマ（最小限）
- \`specs/\` — セクション仕様
- \`screenshots/\` — 見た目の参考

## 開発

\`\`\`bash
npm install
npm run dev
\`\`\`
`
}

// ============================================================
// validate-layout.ts
// ============================================================

function generateValidateScript(): string {
  return `import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const specsPath = join(ROOT, 'specs', 'sections.json')

function main() {
  const errors: string[] = []

  if (!existsSync(specsPath)) {
    console.error('❌ specs/sections.json not found')
    process.exit(1)
  }

  const specsData = JSON.parse(readFileSync(specsPath, 'utf-8'))
  const sections = specsData.sections || []

  for (const sec of sections) {
    const tsxPath = join(ROOT, 'src', 'components', 'sections', sec.componentName + '.tsx')
    if (!existsSync(tsxPath)) {
      errors.push(\`❌ Missing: src/components/sections/\${sec.componentName}.tsx\`)
      continue
    }

    const content = readFileSync(tsxPath, 'utf-8')

    if (!content.includes('data-partcopy-section')) {
      errors.push(\`❌ \${sec.componentName}: missing data-partcopy-section\`)
    }
    if (sec.layoutLocked && !content.includes('data-layout-lock')) {
      errors.push(\`❌ \${sec.componentName}: missing data-layout-lock\`)
    }

    // Check for external links
    const extLinks = content.match(/href=["']https?:\\/\\//g) || []
    if (extLinks.length > 0) {
      errors.push(\`⚠️  \${sec.componentName}: \${extLinks.length} external link(s)\`)
    }
  }

  if (errors.length === 0) {
    console.log('✅ All layout validations passed')
  } else {
    for (const e of errors) console.error(e)
    process.exit(1)
  }
}

main()
`
}

// ============================================================
// Theme CSS (minimal global)
// ============================================================

function generateThemeCss(): string {
  return `@import 'tailwindcss';

:root {
  color-scheme: light;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  min-width: 320px;
  font-family: "Noto Sans JP", "Hiragino Sans", sans-serif;
  color: #0f172a;
  background: #ffffff;
}

/* Utility: placeholder image */
img[src*="placeholder"] {
  background: #e2e8f0;
}
`
}

// ============================================================
// Main export function
// ============================================================

export async function streamTsxZipExport(
  input: TsxZipExportInput,
  res: express.Response
) {
  const { sectionMetas } = input

  if (sectionMetas.length === 0) {
    res.status(404).json({ error: 'No sections to export' })
    return
  }

  const projectName = (input.projectName || input.companyName || 'PARTCOPY Export').trim() || 'PARTCOPY Export'

  // 1. Compile each section to IR, then emit TSX + CSS
  const usedNames = new Set<string>()
  const compiled: {
    componentName: string
    tsx: string
    css: string
    contentKeys: Record<string, string>
    meta: SectionMeta
    ir: SectionIR
    screenshotFile: string
  }[] = []

  for (let i = 0; i < sectionMetas.length; i++) {
    const meta = sectionMetas[i]
    const componentName = buildComponentName(meta.blockFamily, i + 1, usedNames)

    // Compile HTML → Structure IR
    const ir = compileHtmlToStructureIR(meta.html, {
      sectionId: meta.sectionId,
      family: meta.blockFamily,
      screenshotPath: meta.screenshotPath,
      sourceUrl: meta.sourceUrl,
      sourceDomain: meta.sourceDomain,
    })

    // Emit TSX + CSS from IR (pass scopeClass for scoped CSS merge)
    const emitted = emitTsxFromIR(ir, componentName, meta.scopeClass)

    const prefix = String(i + 1).padStart(2, '0')
    const familySlug = meta.blockFamily.replace(/[^a-z0-9_-]+/gi, '-')
    const screenshotFile = `${prefix}-${familySlug}.${meta.screenshotBuffer ? 'png' : 'svg'}`

    compiled.push({
      componentName,
      tsx: emitted.tsx,
      css: emitted.css,
      contentKeys: emitted.contentKeys,
      meta,
      ir,
      screenshotFile,
    })
  }

  // 2. Generate site-content.ts from all content slots
  const contentEntries = compiled.map(c => {
    const obj: Record<string, string> = {}
    for (const [key, val] of Object.entries(c.contentKeys)) {
      obj[key] = val
    }
    return `  ${c.componentName}: ${JSON.stringify(obj, null, 4).replace(/\n/g, '\n  ')},`
  }).join('\n\n')

  const siteContent = `/**
 * site-content.ts
 * 文言の一元管理ファイル。テキスト変更はここを編集してください。
 */

export const content: Record<string, any> = {
${contentEntries}
}
`

  // 3. Generate App.tsx
  const imports = compiled.map(c =>
    `import ${c.componentName} from './components/sections/${c.componentName}'`
  ).join('\n')
  const renders = compiled.map(c => `      <${c.componentName} />`).join('\n')
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

  // 4. Generate specs
  const exportSpecs = compiled.map((c, i) => buildSectionSpec({
    index: i + 1,
    sectionId: c.meta.sectionId,
    blockFamily: c.meta.blockFamily,
    componentName: c.componentName,
    domain: c.meta.sourceDomain || 'unknown',
    sourceUrl: c.meta.sourceUrl,
    screenshotFile: c.screenshotFile,
    textSummary: c.meta.textSummary,
    html: c.meta.html,
    css: c.meta.css,
  }))
  const sectionsMarkdown = buildSectionSpecsMarkdown(exportSpecs)

  const specsForJson = compiled.map((c, i) => ({
    id: c.meta.sectionId,
    order: i + 1,
    componentName: c.componentName,
    blockFamily: c.meta.blockFamily,
    layoutLocked: true,
  }))

  const sectionsJson = JSON.stringify({
    projectName,
    exportedAt: new Date().toISOString(),
    sections: specsForJson,
  }, null, 2)

  const claudeMd = generateClaudeMd(
    projectName,
    input.companyName || '未設定',
    input.serviceDescription || '未設定',
    compiled.map(c => c.componentName),
    compiled.map(c => c.meta.blockFamily)
  )

  const readmeMd = `# ${projectName}

PARTCOPY からエクスポートされた LP テンプレートです。

## セットアップ

\`\`\`bash
npm install
npm run dev
\`\`\`

詳細は \`CLAUDE.md\` を参照してください。
`

  // 5. Stream ZIP
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

  // Scripts
  archive.append(generateValidateScript(), { name: 'scripts/validate-layout.ts' })

  // Public
  archive.append(PLACEHOLDER_SVG, { name: 'public/assets/placeholder.svg' })

  // Source files
  archive.append(indexTsx, { name: 'src/index.tsx' })
  archive.append(appTsx, { name: 'src/App.tsx' })
  archive.append(generateThemeCss(), { name: 'src/theme/theme.css' })
  archive.append(siteContent, { name: 'src/content/site-content.ts' })

  // Section components + CSS Modules + Scoped CSS + Assets
  const assetMap = new Map<string, string>()  // original URL → export filename
  const assetBuffers = new Map<string, Buffer>()  // export filename → buffer

  for (const c of compiled) {
    // Collect asset URLs from HTML and CSS
    const htmlAssets = collectHtmlAssetUrls(c.meta.html)
    const cssAssets = collectCssAssetUrls(c.meta.scopedCss + '\n' + c.meta.fontFaceCss.join('\n'))
    const allAssetUrls = [...new Set([...htmlAssets, ...cssAssets])]

    // Map assets to local filenames (deterministic)
    for (const url of allAssetUrls) {
      if (assetMap.has(url)) continue
      if (url.startsWith('data:')) continue
      // Create deterministic local filename
      const basename = url.split('/').pop()?.split('?')[0] || 'asset'
      const ext = basename.includes('.') ? '' : '.bin'
      const hash = Buffer.from(url).toString('base64url').slice(0, 10)
      const safeName = basename.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40)
      const localName = `${hash}-${safeName}${ext}`
      assetMap.set(url, localName)
    }

    // Rewrite asset URLs in HTML (for scoped CSS and TSX reference)
    const assetReplacer = (url: string) => {
      const local = assetMap.get(url)
      return local ? `/assets/${local}` : undefined
    }

    // Rewrite scoped CSS URLs
    let rewrittenScopedCss = rewriteCssUrls(c.meta.scopedCss, assetReplacer)
    let rewrittenFontFace = c.meta.fontFaceCss.map(ff => rewriteCssUrls(ff, assetReplacer))

    // Build scoped CSS file content
    const scopedCssContent = [
      `/* ${c.componentName} — source scoped CSS */`,
      `/* Scope class: ${c.meta.scopeClass} */`,
      '',
      ...rewrittenFontFace,
      '',
      rewrittenScopedCss,
    ].join('\n')

    // Write files
    archive.append(c.tsx, { name: `src/components/sections/${c.componentName}.tsx` })
    archive.append(c.css, { name: `src/components/sections/${c.componentName}.module.css` })
    archive.append(scopedCssContent, { name: `src/components/sections/${c.componentName}.scoped.css` })

    // Screenshots
    if (c.meta.screenshotBuffer) {
      archive.append(c.meta.screenshotBuffer, { name: `screenshots/${c.screenshotFile}` })
    } else {
      archive.append(SCREENSHOT_PLACEHOLDER_SVG, { name: `screenshots/${c.screenshotFile}` })
    }
  }

  // Add collected assets to ZIP
  for (const [url, localName] of assetMap) {
    // Try to fetch asset data (stored or remote)
    // We write placeholder for assets we can't resolve at export time
    // The asset loading is handled by the server's existing pipeline
    // For now, record the mapping in specs for manual resolution
  }

  // Asset map for reference
  if (assetMap.size > 0) {
    const assetIndex = JSON.stringify(
      Object.fromEntries([...assetMap.entries()].slice(0, 200)),
      null, 2
    )
    archive.append(assetIndex, { name: 'specs/asset-map.json' })
  }

  await archive.finalize()
}
