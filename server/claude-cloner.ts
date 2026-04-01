/**
 * Claude Page Cloner
 * Uses locally authenticated `claude -p` CLI to intelligently clone a web page.
 * Claude executes curl/grep/sed commands to download HTML, CSS, images, fonts,
 * then rewrites paths for local use.
 */
import { spawn } from 'child_process'
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { logger } from './logger.js'

const CLONE_PROMPT = `あなたはWebページクローンの専門家です。
指定されたURLのページを完全にローカルで動作するようにクローンしてください。

以下のステップを順番に実行してください。各ステップでbashコマンドを実行してください。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【作業ディレクトリ】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
__WORKDIR__

このディレクトリは既に存在します。すべてのファイルをここに保存してください。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【Step 1: HTML取得】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
curl -sL "__URL__" \\
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \\
  -H "Accept: text/html,application/xhtml+xml" \\
  -o __WORKDIR__/index.html

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【Step 2: CSS取得】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HTMLから <link rel="stylesheet"> と .css を含むhrefを抽出。
相対URLはページのオリジン(__ORIGIN__)を付けて絶対URLに変換。
mkdir -p __WORKDIR__/css として各CSSをダウンロード。
Google Fontsの場合はUser-Agentヘッダー必須。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【Step 3: 画像取得】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HTMLとCSSから画像URLを抽出（src, srcset, background-image, url()）。
mkdir -p __WORKDIR__/images としてダウンロード。
対象: .png, .jpg, .jpeg, .svg, .webp, .gif, .avif, .ico
大きすぎるファイル（5MB超）はスキップ。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【Step 4: フォント取得】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CSS内の@font-faceからフォントURLを抽出。
Google Fonts CSSがあればそれもダウンロードしてフォントファイルを取得。
mkdir -p __WORKDIR__/fonts として保存。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【Step 5: パス書き換え】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
index.htmlとCSSファイル内の外部URLをローカルパスに書き換え。
- CSS: href="https://..." → href="css/filename.css"
- 画像: src="https://..." → src="images/filename.ext"
- フォント: url(https://...) → url(fonts/filename.woff2)
- 相対パスもローカルに変換

sed -i '' コマンドを使って一括置換。macOSのsedを使用（-i ''が必要）。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【Step 6: 不要要素の除去】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
index.htmlから以下を除去:
- Google Tag Manager (GTM)
- Google Analytics
- Facebook Pixel
- その他のトラッキングスクリプト
- preconnect/prefetch/dns-prefetchのlinkタグ

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【Step 7: リンク無効化】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
すべての<a>タグのhrefを"#"に変更して遷移を無効化。
ただしページ内リンク（#で始まるもの）はそのまま維持。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【重要な注意事項】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 各コマンドが失敗してもエラーで止まらず、次のステップに進むこと
- ダウンロードは合計100ファイルまでに制限すること
- 1ファイル5MB以上はスキップすること
- 最後に「CLONE_COMPLETE」と出力すること
- 作業完了後、__WORKDIR__/index.html が完全なローカルクローンになっていること
`

export interface CloneResult {
  workdir: string
  indexHtml: string
  files: { path: string; size: number; type: string }[]
  stats: {
    htmlSizeKb: number
    cssFiles: number
    imageFiles: number
    fontFiles: number
    totalFiles: number
  }
}

export async function clonePageWithClaude(url: string): Promise<CloneResult> {
  const id = randomUUID().slice(0, 8)
  const workdir = join(process.cwd(), '.partcopy', 'clones', id)
  mkdirSync(workdir, { recursive: true })

  const origin = new URL(url).origin

  const prompt = CLONE_PROMPT
    .replace(/__URL__/g, url)
    .replace(/__WORKDIR__/g, workdir)
    .replace(/__ORIGIN__/g, origin)

  logger.info('Starting Claude page clone', { url, workdir })

  await runClaudeClone(prompt)

  // Read results
  const indexPath = join(workdir, 'index.html')
  if (!existsSync(indexPath)) {
    throw new Error('クローン失敗: index.htmlが生成されませんでした')
  }

  const indexHtml = readFileSync(indexPath, 'utf-8')
  const files = collectFiles(workdir)

  const cssFiles = files.filter(f => f.path.endsWith('.css'))
  const imageFiles = files.filter(f => /\.(png|jpg|jpeg|svg|webp|gif|avif|ico)$/i.test(f.path))
  const fontFiles = files.filter(f => /\.(woff2?|ttf|eot|otf)$/i.test(f.path))

  const result: CloneResult = {
    workdir,
    indexHtml,
    files,
    stats: {
      htmlSizeKb: Math.round(Buffer.byteLength(indexHtml, 'utf-8') / 1024),
      cssFiles: cssFiles.length,
      imageFiles: imageFiles.length,
      fontFiles: fontFiles.length,
      totalFiles: files.length
    }
  }

  logger.info('Claude page clone complete', { url, stats: result.stats })
  return result
}

function collectFiles(dir: string, base = ''): { path: string; size: number; type: string }[] {
  const results: { path: string; size: number; type: string }[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const rel = base ? `${base}/${entry}` : entry
      const stat = statSync(full)
      if (stat.isDirectory()) {
        results.push(...collectFiles(full, rel))
      } else {
        const ext = entry.split('.').pop()?.toLowerCase() || ''
        let type = 'other'
        if (ext === 'html') type = 'html'
        else if (ext === 'css') type = 'css'
        else if (['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'avif', 'ico'].includes(ext)) type = 'image'
        else if (['woff', 'woff2', 'ttf', 'eot', 'otf'].includes(ext)) type = 'font'
        else if (ext === 'js') type = 'js'
        results.push({ path: rel, size: stat.size, type })
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results
}

function runClaudeClone(prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (!settled) { settled = true; fn() }
    }

    const child = spawn('claude', ['-p', '--allowedTools', 'Bash', '-'], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        TERM: process.env.TERM,
      },
      timeout: 180_000, // 3 minutes max
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      if (code !== 0) {
        logger.error('Claude clone CLI failed', { exitCode: code, stderr: stderr.slice(0, 500) })
        // Still try to resolve - partial clone may be useful
        if (stdout.includes('CLONE_COMPLETE') || existsSync(join(process.cwd(), '.partcopy', 'clones'))) {
          settle(() => resolve())
        } else {
          settle(() => reject(new Error(`Claudeクローンに失敗しました (exit ${code})`)))
        }
        return
      }

      settle(() => resolve())
    })

    child.on('error', (err) => {
      logger.error('Claude clone spawn error', { error: err.message })
      settle(() => reject(new Error(`Claude CLIの起動に失敗しました: ${err.message}`)))
    })

    // Send prompt via stdin
    child.stdin.write(prompt)
    child.stdin.end()
  })
}
