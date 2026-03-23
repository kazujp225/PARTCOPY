/**
 * Claude TSX Converter
 * Uses `claude -p` CLI to convert HTML sections to React TSX components.
 */
import { spawn } from 'child_process'
import { logger } from './logger.js'

const CONVERT_PROMPT = `あなたはHTML→React TSXコンバーターです。
以下のHTMLをReact TSXコンポーネントに変換してください。

【最重要ルール - デザイン完全保持】
- フォント指定（font-family, font-weight, font-size）は絶対に変更・省略しないこと
- 色（color, background-color, gradient）は元のまま完全に保持すること
- レイアウト（display, flexbox, grid, position, margin, padding）は1pxもずれないように再現すること
- 元サイトのデザインを崩すことは一切許されない

ルール:
- 元のCSSスタイルをそのまま保持すること（インラインstyleオブジェクトに変換）
- @font-faceルールがある場合はそのまま保持すること
- class属性はclassNameに変換
- imgのaltは保持、自己閉じタグに修正
- 画像のsrc URLはそのまま保持すること
- コンポーネント名はSectionComponentとする
- export default で公開
- 不要なscriptタグは除去
- コメントは日本語で最小限
- TSXコードブロックのみを返すこと（説明不要）

HTML:
`

const MAX_HTML_INPUT_CHARS = 200_000

export async function convertHtmlToTsx(html: string, blockFamily?: string): Promise<string> {
  const componentName = blockFamily
    ? blockFamily.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') + 'Section'
    : 'SectionComponent'

  // Truncate very large HTML to avoid overwhelming Claude
  const truncatedHtml = html.length > MAX_HTML_INPUT_CHARS
    ? html.slice(0, MAX_HTML_INPUT_CHARS) + '\n<!-- truncated -->'
    : html

  if (html.length > MAX_HTML_INPUT_CHARS) {
    logger.warn('HTML input truncated for Claude conversion', { original: html.length, truncated: MAX_HTML_INPUT_CHARS })
  }

  const prompt = CONVERT_PROMPT.replace('SectionComponent', componentName) + truncatedHtml

  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (!settled) { settled = true; fn() }
    }

    // stdinでプロンプトを渡す（引数長制限を回避）
    const child = spawn('claude', ['-p', '-'], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        TERM: process.env.TERM,
      },
      timeout: 120_000,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    child.on('close', (code) => {
      if (code !== 0) {
        logger.error('Claude CLI failed', { exitCode: code, stderr: stderr.slice(0, 500) })
        settle(() => reject(new Error(`Claude変換に失敗しました (exit ${code})`)))
        return
      }

      // Extract TSX code from response (may be wrapped in ```tsx ... ```)
      let tsxCode = stdout.trim()
      const codeBlockMatch = tsxCode.match(/```(?:tsx|jsx|typescript|javascript)?\s*\n([\s\S]*?)```/)
      if (codeBlockMatch) {
        tsxCode = codeBlockMatch[1].trim()
      }

      if (!tsxCode) {
        settle(() => reject(new Error('Claude returned empty output')))
        return
      }

      settle(() => resolve(tsxCode))
    })

    child.on('error', (err) => {
      settle(() => reject(new Error(`Claude CLIが見つかりません: ${err.message}`)))
    })

    // プロンプトをstdinに書き込み
    child.stdin.write(prompt)
    child.stdin.end()
  })
}
