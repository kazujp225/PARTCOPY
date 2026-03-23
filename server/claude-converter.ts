/**
 * Claude TSX Converter
 * Uses `claude -p` CLI to convert HTML sections to React TSX components.
 */
import { execFile } from 'child_process'
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

const MAX_HTML_INPUT_CHARS = 50_000

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

    const child = execFile('claude', ['-p', prompt], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        TERM: process.env.TERM,
      },
    }, (err, stdout, stderr) => {
      if (err) {
        logger.error('Claude CLI failed', { error: err.message, stderr })
        settle(() => reject(new Error(`Claude変換に失敗しました: ${err.message}`)))
        return
      }

      // Extract TSX code from response (may be wrapped in ```tsx ... ```)
      let code = (stdout || '').trim()
      const codeBlockMatch = code.match(/```(?:tsx|jsx|typescript|javascript)?\s*\n([\s\S]*?)```/)
      if (codeBlockMatch) {
        code = codeBlockMatch[1].trim()
      }

      if (!code) {
        settle(() => reject(new Error('Claude returned empty output')))
        return
      }

      settle(() => resolve(code))
    })

    child.on('error', (err) => {
      settle(() => reject(new Error(`Claude CLIが見つかりません: ${err.message}`)))
    })
  })
}
