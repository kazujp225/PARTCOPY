/**
 * Claude-based Section Classifier
 * Uses local `claude -p` CLI to classify sections into block families.
 * Processes sections in batches for efficiency.
 */
import { spawn } from 'child_process'
import { logger } from './logger.js'
import { HAS_SUPABASE, supabaseAdmin } from './supabase.js'

const BATCH_SIZE = 15 // sections per Claude call
const TIMEOUT_MS = 120_000 // 2 min per batch

const VALID_FAMILIES = [
  'navigation', 'hero', 'feature', 'social_proof', 'stats', 'pricing',
  'faq', 'content', 'cta', 'contact', 'recruit', 'footer', 'news_list',
  'timeline', 'company_profile', 'gallery', 'logo_cloud'
] as const

const CLASSIFY_PROMPT = `あなたはWebサイトのセクション分類器です。以下のセクション一覧を分析し、各セクションの種別を判定してください。

【種別一覧】
- navigation: ナビゲーション・ヘッダーメニュー（サイト上部のメニューバー、ナビリンク）
- hero: ヒーロー・メインビジュアル（ファーストビュー、大きな見出し+CTA）
- feature: 特徴・サービス紹介（カード型の機能・サービス説明）
- social_proof: 導入実績・お客様の声（テスティモニアル、導入事例）
- stats: 数字・実績（数値データ、カウンター）
- pricing: 料金プラン（価格表、プラン比較）
- faq: よくある質問（Q&A、アコーディオン）
- content: 一般コンテンツ（ブログ記事、テキスト中心）
- cta: CTA（行動喚起ボタン、バナー）
- contact: お問い合わせ（フォーム、連絡先情報）
- recruit: 採用情報（求人、キャリア）
- footer: フッター（サイト下部のリンク集、コピーライト）
- news_list: お知らせ一覧（ニュース、更新情報）
- timeline: 沿革・タイムライン（歴史、ステップ）
- company_profile: 会社概要（会社情報、代表挨拶）
- gallery: ギャラリー（画像ギャラリー、ポートフォリオ）
- logo_cloud: ロゴ一覧（パートナー企業ロゴ、取引先ロゴ）

【判定のポイント】
- タグ名がnav/headerならnavigation、footerならfooter
- ページ上部でリンクが多ければnavigation
- 大きな見出し+ボタンがあるファーストビューはhero
- カード3つ以上並んでいればfeature
- フォームがあればcontact
- 採用・求人のキーワードがあればrecruit
- 数字が目立つ（XX件、XX社、XX%）ならstats
- Q&Aパターンならfaq
- 「わからない」場合はcontent

必ず以下のJSON配列形式で返してください。他のテキストは不要です：
[{"id":"セクションID","family":"種別名","confidence":0.0-1.0}]`

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`))
      } else {
        resolve(stdout)
      }
    })

    proc.on('error', (err) => reject(err))

    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

interface SectionForClassification {
  id: string
  tag_name: string
  text_summary: string
  features_jsonb: any
  block_family: string
  classifier_confidence: number
}

/**
 * Reclassify sections using Claude CLI.
 * Targets sections with low confidence or generic "content"/"cta" classification.
 */
export async function reclassifySections(options?: { siteId?: string; limit?: number }): Promise<{ updated: number; errors: number }> {
  if (!HAS_SUPABASE) {
    logger.warn('Claude classifier: Supabase required')
    return { updated: 0, errors: 0 }
  }

  // Fetch sections needing reclassification
  let query = supabaseAdmin
    .from('source_sections')
    .select('id, tag_name, text_summary, features_jsonb, block_family, classifier_confidence')
    .or('classifier_confidence.lt.0.7,block_family.eq.content,block_family.eq.cta')
    .order('created_at', { ascending: false })
    .limit(options?.limit || 500)

  if (options?.siteId) {
    query = query.eq('site_id', options.siteId)
  }

  const { data: sections, error } = await query

  if (error) {
    logger.error('Claude classifier: fetch failed', { error: error.message })
    return { updated: 0, errors: 1 }
  }

  if (!sections || sections.length === 0) {
    logger.info('Claude classifier: no sections to reclassify')
    return { updated: 0, errors: 0 }
  }

  logger.info('Claude classifier: starting', { totalSections: sections.length })

  let updated = 0
  let errors = 0

  // Process in batches
  for (let i = 0; i < sections.length; i += BATCH_SIZE) {
    const batch = sections.slice(i, i + BATCH_SIZE)

    // Build prompt with section summaries
    const sectionDescriptions = batch.map((s: SectionForClassification, idx: number) => {
      const features = s.features_jsonb || {}
      return `[${idx + 1}] ID: ${s.id}
タグ: <${s.tag_name}>
テキスト: ${(s.text_summary || '').slice(0, 200)}
特徴: 見出し${features.headingCount || 0}個, リンク${features.linkCount || 0}個, ボタン${features.buttonCount || 0}個, フォーム${features.formCount || 0}個, 画像${features.imageCount || 0}個, カード${features.cardCount || 0}個
現在の分類: ${s.block_family} (${s.classifier_confidence})`
    }).join('\n\n')

    const fullPrompt = `${CLASSIFY_PROMPT}\n\n--- セクション一覧 (${batch.length}件) ---\n\n${sectionDescriptions}`

    try {
      const result = await runClaude(fullPrompt)

      // Parse JSON from Claude's response
      const jsonMatch = result.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        logger.warn('Claude classifier: no JSON in response', { batch: i })
        errors++
        continue
      }

      const classifications: Array<{ id: string; family: string; confidence: number }> = JSON.parse(jsonMatch[0])

      // Update each section
      for (const cls of classifications) {
        if (!VALID_FAMILIES.includes(cls.family as any)) continue
        if (cls.family === batch.find((s: SectionForClassification) => s.id === cls.id)?.block_family) continue // no change

        const { error: updateError } = await supabaseAdmin
          .from('source_sections')
          .update({
            block_family: cls.family,
            classifier_confidence: cls.confidence,
            classifier_type: 'claude',
          })
          .eq('id', cls.id)

        if (updateError) {
          errors++
        } else {
          updated++
        }
      }

      logger.info('Claude classifier: batch done', {
        batch: Math.floor(i / BATCH_SIZE) + 1,
        total: Math.ceil(sections.length / BATCH_SIZE),
        updated,
      })
    } catch (err: any) {
      logger.error('Claude classifier: batch failed', { error: err.message })
      errors++
    }
  }

  logger.info('Claude classifier: complete', { updated, errors, total: sections.length })
  return { updated, errors }
}
