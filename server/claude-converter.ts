/**
 * Claude TSX Converter
 * Uses `claude -p` CLI to convert HTML sections to React TSX components.
 */
import { execFile } from 'child_process'
import { logger } from './logger.js'

const CONVERT_PROMPT = `あなたはHTML→React TSXコンバーターです。
以下のHTMLをReact TSXコンポーネントに変換してください。

ルール:
- 元のCSSスタイルをそのまま保持すること（インラインstyleオブジェクトに変換）
- class属性はclassNameに変換
- imgのaltは保持、自己閉じタグに修正
- コンポーネント名はSectionComponentとする
- export default で公開
- 不要なscriptタグは除去
- コメントは日本語で最小限
- TSXコードブロックのみを返すこと（説明不要）

HTML:
`

export async function convertHtmlToTsx(html: string, blockFamily?: string): Promise<string> {
  const componentName = blockFamily
    ? blockFamily.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') + 'Section'
    : 'SectionComponent'

  const prompt = CONVERT_PROMPT.replace('SectionComponent', componentName) + html

  return new Promise((resolve, reject) => {
    const child = execFile('claude', ['-p', prompt], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      if (err) {
        logger.error('Claude CLI failed', { error: err.message, stderr })
        reject(new Error(`Claude変換に失敗しました: ${err.message}`))
        return
      }

      // Extract TSX code from response (may be wrapped in ```tsx ... ```)
      let code = stdout.trim()
      const codeBlockMatch = code.match(/```(?:tsx|jsx|typescript|javascript)?\s*\n([\s\S]*?)```/)
      if (codeBlockMatch) {
        code = codeBlockMatch[1].trim()
      }

      resolve(code)
    })

    child.on('error', (err) => {
      reject(new Error(`Claude CLIが見つかりません: ${err.message}`))
    })
  })
}
