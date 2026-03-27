/**
 * Claude TSX Converter
 * Uses locally authenticated `claude -p` CLI to convert HTML sections to React TSX components.
 */
import { spawn } from 'child_process'
import { logger } from './logger.js'

const CONVERT_PROMPT = `あなたはHTML→React TSXコンバーターです。
以下のHTMLを、Claude Codeで編集しやすい構造のReact TSXコンポーネントに変換してください。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【最重要ルール - デザイン完全保持】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- フォント指定（font-family, font-weight, font-size, letter-spacing, line-height）は絶対に変更・省略しないこと
- 色（color, background-color, gradient, border-color, box-shadow）は元のまま完全に保持すること
- レイアウト（display, flexbox, grid, position, margin, padding, width, height, gap）は1pxもずれないように再現すること
- border-radius, opacity, transform, transitionなどの装飾プロパティも完全に保持すること
- 元サイトのデザインを崩すことは一切許されない

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【出力構造 - 編集しやすいコンポーネント設計】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ ファイル冒頭に編集ガイドブロックを配置:
コンポーネントの先頭に以下の形式でコメントブロックを出力すること:

{/*
 * ========================================
 * 編集ガイド - SectionComponent
 * ========================================
 *
 * 【テキスト一覧】（検索・置換で編集可能）
 * - 見出し: "〇〇〇〇"
 * - 小見出し: "〇〇〇〇"
 * - 本文: "〇〇〇〇..."
 * - ボタン: "〇〇〇〇"
 * （HTMLから実際に抽出したテキストを記載）
 *
 * 【画像パス一覧】
 * - メイン画像: /assets/hero.png（元URL: https://...）
 * - ロゴ: /assets/logo.png（元URL: https://...）
 * （全ての<img>のsrcを列挙）
 *
 * 【カラー設定】
 * - メインカラー: #XXXXXX
 * - 背景色: #XXXXXX
 * - テキスト色: #XXXXXX
 * （使用されている主要カラーを列挙）
 */}

■ テキストコンテンツの扱い:
- 全てのテキストをコンポーネント先頭でオブジェクトにまとめて定義すること:

const texts = {
  heading: "見出しテキスト",       // 見出し
  subHeading: "サブテキスト",      // 小見出し
  description: "本文テキスト...",   // 説明文
  buttonLabel: "ボタンラベル",     // ボタン
} as const;

- JSX内では {texts.heading} のように参照すること
- 長い本文も省略せず全文を含めること

■ 画像パスの扱い:
- 全ての画像URLをコンポーネント先頭でオブジェクトにまとめて定義すること:

const images = {
  hero: "/assets/hero.png",      // 元URL: https://example.com/img/hero.jpg
  logo: "/assets/logo.png",      // 元URL: https://example.com/img/logo.svg
} as const;

- 外部URLは全て "/assets/ファイル名.拡張子" のローカル相対パスに変換すること
- 元のURLはコメントとして残すこと
- background-image の url() 内も同様にローカルパスに変換すること
- JSX内では {images.hero} のように参照すること
- alt属性は元のまま保持すること

■ CSSスタイルの扱い（ハイブリッド方式）:
- レイアウト系（display, flexbox, grid, position, margin, padding, width, height, gap, align, justify）
  → インラインstyleオブジェクトで記述（配置の微調整がしやすいため）
- ビジュアル系（color, background, font系, border, border-radius, box-shadow, opacity, transform, transition）
  → コンポーネント末尾の <style> JSXブロックにまとめること

<style>ブロックの書き方:
コンポーネントの return 内の末尾に以下の形式で記述:

<style>{\`
  /* セクション全体の色・フォント設定 */
  .section-heading {
    font-family: 'Noto Sans JP', sans-serif;
    font-size: 32px;
    font-weight: 700;
    color: #1a1a1a;
  }

  .section-button {
    background-color: #0066ff;
    color: #ffffff;
    border-radius: 8px;
    transition: opacity 0.3s ease;
  }

  /* レスポンシブ */
  @media (max-width: 768px) {
    .section-heading {
      font-size: 24px;
    }
  }
\`}</style>

- クラス名はコンポーネントスコープを意識して、セクション固有のプレフィックス付きにすること
  例: .hero-heading, .hero-button, .pricing-card
- 元サイトのCSS全体をコピーしないこと。このセクションで実際に使われているスタイルのみを含めること
- 使われていないクラスのスタイルは含めないこと
- @font-faceルールがある場合はstyleブロック先頭に含めること
- @mediaクエリが元HTMLにあれば保持すること

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【一般ルール】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- class属性はclassNameに変換すること
- imgは自己閉じタグ <img /> にすること
- 不要な<script>タグは除去すること
- コンポーネント名は SectionComponent とすること
- export default で公開すること
- コメントは全て日本語で記述すること
- 変数名・関数名・クラス名は英語で記述すること
- TSXコードブロック(\`\`\`tsx ... \`\`\`)のみを返すこと（説明文は不要）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【映像要素の除去】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- <video>タグとその内容は完全に除去すること
- YouTube/Vimeo/Dailymotionの<iframe>も完全に除去すること
- 映像があった場所には何も出力しないこと（プレースホルダー不要）
- <img>タグは画像なので除去しないこと（映像とは別）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【出力例の骨格】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

\`\`\`tsx
import React from "react";

{/*
 * ========================================
 * 編集ガイド - SectionComponent
 * ========================================
 * 【テキスト一覧】
 * - 見出し: "..."
 * 【画像パス一覧】
 * - メイン: /assets/hero.png（元URL: ...）
 * 【カラー設定】
 * - メイン: #0066ff
 */}

/* テキストコンテンツ（編集はここで一括管理） */
const texts = { ... } as const;

/* 画像パス（実際のファイルを /assets/ に配置してください） */
const images = { ... } as const;

const SectionComponent: React.FC = () => {
  return (
    <section style={{ display: "flex", ... }}>
      <h1 className="sec-heading">{texts.heading}</h1>
      <img src={images.hero} alt="..." />

      {/* スコープ付きスタイル定義 */}
      <style>{\\\`
        .sec-heading { font-size: 32px; color: #1a1a1a; }
      \\\`}</style>
    </section>
  );
};

export default SectionComponent;
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

変換対象のHTML:
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

  const prompt = CONVERT_PROMPT.replace(/SectionComponent/g, componentName) + truncatedHtml

  // Try conversion with retry on failure
  try {
    return await runClaudeConversion(prompt)
  } catch (firstError: any) {
    logger.warn('Claude conversion failed, retrying once', { error: firstError.message })
    try {
      return await runClaudeConversion(prompt)
    } catch (retryError: any) {
      logger.error('Claude conversion failed after retry', { error: retryError.message })
      throw retryError
    }
  }
}

function runClaudeConversion(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (!settled) { settled = true; fn() }
    }

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

    child.stdin.write(prompt)
    child.stdin.end()
  })
}
