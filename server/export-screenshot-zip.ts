/**
 * Screenshot ZIP Export Service
 * server/index.ts から分離した既存のスクショベースエクスポートロジック。
 */
import archiver from 'archiver'
import type express from 'express'

import {
  buildClaudeInstructions,
  buildComponentName,
  buildSectionSpec,
  buildSectionSpecsMarkdown,
  type ExportSectionSpec,
} from './export-instructions.js'
import { logger } from './logger.js'

// ============================================================
// Types
// ============================================================
export interface ExportSectionArtifact {
  sectionId: string
  blockFamily: string
  componentName: string
  domain: string
  sourceUrl?: string
  sourceTitle?: string
  textSummary?: string
  screenshotFile: string
  screenshotBuffer?: Buffer
  html: string
  css: string
}

export interface ScreenshotZipExportArgs {
  sectionIds: string[]
  projectName?: string
  companyName?: string
  serviceDescription?: string
}

/**
 * Artifact を取得するコールバック型。
 * server/index.ts 側の DB アクセスを注入する。
 */
export type GetArtifactFn = (
  sectionId: string,
  index: number,
  usedComponentNames: Set<string>
) => Promise<ExportSectionArtifact | null>

// ============================================================
// Static file content generators
// ============================================================
function generatePackageJson() {
  return JSON.stringify({
    name: 'partcopy-rebuild-kit',
    private: true,
    version: '1.0.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc -b && vite build'
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
      vite: '^8.0.3'
    }
  }, null, 2)
}

function generateTsconfigJson() {
  return JSON.stringify({
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
    include: ['src']
  }, null, 2)
}

function generateIndexHtml(projectName: string) {
  return `<!DOCTYPE html>
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
}

const INDEX_CSS = `@import 'tailwindcss';

:root {
  color-scheme: light;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  min-width: 320px;
  background: #f8fafc;
  color: #0f172a;
  font-family: "Noto Sans JP", "Hiragino Sans", sans-serif;
}
`

const INDEX_TSX = `import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
`

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
`

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480"><rect width="800" height="480" fill="#e2e8f0"/><text x="400" y="240" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="22">Replace with your own asset</text></svg>`

const SCREENSHOT_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900"><rect width="1440" height="900" fill="#f8fafc"/><rect x="48" y="48" width="1344" height="804" rx="32" fill="#e2e8f0" stroke="#cbd5e1" stroke-width="4" stroke-dasharray="12 12"/><text x="720" y="438" text-anchor="middle" fill="#475569" font-family="sans-serif" font-size="32">Screenshot unavailable</text><text x="720" y="490" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="20">Use specs/sections.md and the section summary to rebuild this part.</text></svg>`

function generateReadme() {
  return `# PARTCOPY Rebuild Kit

このZIPには元HTML/CSSではなく、スクリーンショットと再現指示書が入っています。

## 使い方

1. \`screenshots/\` で見た目を確認
2. \`specs/sections.md\` で構成情報を確認
3. \`CLAUDE.md\` を Claude Code に渡して \`src/components/\` を順番に実装

## 開発

\`\`\`bash
npm install
npm run dev
\`\`\`
`
}

function generateAppTsx(artifacts: ExportSectionArtifact[]) {
  const imports = artifacts
    .map((a) => `import ${a.componentName} from './components/${a.componentName}'`)
    .join('\n')
  const renders = artifacts
    .map((a) => `      <${a.componentName} />`)
    .join('\n')
  return `${imports}

export default function App() {
  return (
    <main className="min-h-screen">
${renders}
    </main>
  )
}
`
}

function generateComponentStub(componentName: string, familyLabel: string, screenshotFile: string) {
  return `export default function ${componentName}() {
  return (
    <section className="px-6 py-20">
      <div className="mx-auto max-w-6xl rounded-3xl border border-dashed border-slate-300 bg-white p-10 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
          ${familyLabel}
        </p>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-slate-900">
          ${componentName}
        </h2>
        <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
          screenshots/${screenshotFile} と specs/sections.md を参考に Tailwind で再構築してください。
        </p>
      </div>
    </section>
  )
}
`
}

// ============================================================
// Main Export Function
// ============================================================
export async function streamScreenshotZipExport(
  args: ScreenshotZipExportArgs,
  res: express.Response,
  getArtifact: GetArtifactFn
) {
  const usedComponentNames = new Set<string>()
  const artifacts: ExportSectionArtifact[] = []

  for (let i = 0; i < args.sectionIds.length; i++) {
    const artifact = await getArtifact(args.sectionIds[i], i + 1, usedComponentNames)
    if (artifact) artifacts.push(artifact)
  }

  if (artifacts.length === 0) {
    res.status(404).json({ error: 'No exportable sections found' })
    return
  }

  const specs: ExportSectionSpec[] = artifacts.map((artifact, i) => buildSectionSpec({
    index: i + 1,
    sectionId: artifact.sectionId,
    blockFamily: artifact.blockFamily,
    componentName: artifact.componentName,
    domain: artifact.domain,
    sourceUrl: artifact.sourceUrl,
    sourceTitle: artifact.sourceTitle,
    screenshotFile: artifact.screenshotFile,
    textSummary: artifact.textSummary,
    html: artifact.html,
    css: artifact.css
  }))

  const projectName = (args.projectName || args.companyName || 'PARTCOPY Export Project').trim() || 'PARTCOPY Export Project'
  const claudeMd = buildClaudeInstructions({ projectName, companyName: args.companyName, serviceDescription: args.serviceDescription, specs })
  const sectionsMarkdown = buildSectionSpecsMarkdown(specs)
  const sectionsJson = JSON.stringify({ projectName, exportedAt: new Date().toISOString(), sections: specs }, null, 2)

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', 'attachment; filename="partcopy-export.zip"')

  const archive = archiver('zip', { zlib: { level: 9 } })
  archive.on('error', (archiveErr: Error) => {
    logger.error('Archiver error mid-stream', { error: archiveErr.message })
    if (!res.headersSent) {
      res.status(500).json({ error: archiveErr.message })
    } else {
      res.end()
    }
  })

  archive.pipe(res)
  archive.append(claudeMd, { name: 'CLAUDE.md' })
  archive.append(generateReadme(), { name: 'README.md' })
  archive.append(sectionsMarkdown, { name: 'specs/sections.md' })
  archive.append(sectionsJson, { name: 'specs/sections.json' })
  archive.append(generateIndexHtml(projectName), { name: 'index.html' })
  archive.append(generatePackageJson(), { name: 'package.json' })
  archive.append(generateTsconfigJson(), { name: 'tsconfig.json' })
  archive.append(VITE_CONFIG, { name: 'vite.config.ts' })
  archive.append(INDEX_CSS, { name: 'src/index.css' })
  archive.append(INDEX_TSX, { name: 'src/index.tsx' })
  archive.append(generateAppTsx(artifacts), { name: 'src/App.tsx' })
  archive.append(PLACEHOLDER_SVG, { name: 'public/assets/placeholder.svg' })

  for (const artifact of artifacts) {
    const spec = specs.find((entry) => entry.id === artifact.sectionId)
    archive.append(
      generateComponentStub(artifact.componentName, spec?.blockFamilyLabel || artifact.blockFamily, artifact.screenshotFile),
      { name: `src/components/${artifact.componentName}.tsx` }
    )

    if (artifact.screenshotBuffer) {
      archive.append(artifact.screenshotBuffer, { name: `screenshots/${artifact.screenshotFile}` })
    } else {
      archive.append(SCREENSHOT_PLACEHOLDER_SVG, { name: `screenshots/${artifact.screenshotFile}` })
    }
  }

  await archive.finalize()
}
