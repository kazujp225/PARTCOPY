/**
 * Capture Runner
 * Puppeteer page capture: goto, lazy-load, page.content(), screenshot
 */
import type { Page, Browser } from 'puppeteer'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

export interface CaptureResult {
  finalUrl: string
  title: string
  lang: string
  finalHtml: string
  fullScreenshot: Buffer
  viewport: { width: number; height: number }
}

export async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })
}

export async function capturePage(page: Page, url: string): Promise<CaptureResult> {
  await page.setViewport({ width: 1440, height: 900 })
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  )

  // Random delay (1-3s) before navigation to appear more human-like
  await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000))

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })

  // SPAやクライアントサイドレンダリングの完了を待機
  await page.evaluate(async () => {
    // React/Next.js/Nuxt等のhydration完了を待つ
    await new Promise<void>(resolve => {
      if (document.readyState === 'complete') {
        resolve()
      } else {
        window.addEventListener('load', () => resolve(), { once: true })
      }
    })
  })
  await new Promise(r => setTimeout(r, 2000))

  // 全アニメーション・トランジションを強制完了
  await page.evaluate(() => {
    // CSS animationを最終フレームにスキップ
    document.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el)
      if (cs.animationName && cs.animationName !== 'none') {
        (el as HTMLElement).style.animationDuration = '0s'
        ;(el as HTMLElement).style.animationDelay = '0s'
        ;(el as HTMLElement).style.animationPlayState = 'paused'
      }
      if (cs.transition && cs.transition !== 'all 0s ease 0s') {
        (el as HTMLElement).style.transitionDuration = '0s'
      }
      // 非表示のfade-in要素を強制表示
      if (cs.opacity === '0') {
        (el as HTMLElement).style.opacity = '1'
      }
    })
  })

  // 遅延読み込みをトリガー：ゆっくりスクロール + 各位置で待機
  await page.evaluate(async () => {
    if (typeof (globalThis as any).__name === 'undefined') (globalThis as any).__name = (t: any) => t
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
    const totalHeight = document.body.scrollHeight
    const step = Math.floor(window.innerHeight * 0.7)

    // 1回目：ゆっくりスクロールしてIntersectionObserverをトリガー
    for (let y = 0; y < totalHeight; y += step) {
      window.scrollTo({ top: y, behavior: 'smooth' })
      await delay(400)
    }
    // ページ末尾で待機（フッター付近の遅延読み込み用）
    window.scrollTo(0, totalHeight)
    await delay(1000)

    // 2回目：高さが増えた場合に追加スクロール
    const newHeight = document.body.scrollHeight
    if (newHeight > totalHeight + 200) {
      for (let y = totalHeight; y < newHeight; y += step) {
        window.scrollTo(0, y)
        await delay(300)
      }
    }

    // トップに戻る
    window.scrollTo(0, 0)
    await delay(500)
  })

  // 遅延読み込み画像の読み込み完了を待機
  await page.evaluate(async () => {
    const images = Array.from(document.querySelectorAll('img'))
    await Promise.allSettled(
      images.filter(img => !img.complete).map(img =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true })
          img.addEventListener('error', () => resolve(), { once: true })
          setTimeout(() => resolve(), 3000)
        })
      )
    )
  })
  await new Promise(r => setTimeout(r, 500))

  // Get final rendered HTML (JS-executed DOM)
  const finalHtml = await page.content()
  const title = await page.title()
  const lang = await page.evaluate(() => document.documentElement.lang || 'ja')
  const finalUrl = page.url()

  // Full page screenshot (QA用)
  const fullScreenshot = await page.screenshot({ fullPage: true }) as Buffer

  return { finalUrl, title, lang, finalHtml, fullScreenshot, viewport: { width: 1440, height: 900 } }
}

/**
 * ページ内の同一ドメインリンクを収集する。
 *
 * - 同じドメインのリンクのみ（サブドメイン違いは除外）
 * - アンカー(#)、ファイルダウンロード(.pdf, .zip等)、認証ページをスキップ
 * - 正規化して重複を除去
 */
export async function collectPageLinks(page: Page, baseUrl: string): Promise<string[]> {
  const baseParsed = new URL(baseUrl)
  const baseDomain = baseParsed.hostname.replace(/^www\./, '')

  // ブラウザ内でリンクを収集
  const rawLinks: string[] = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => (a as HTMLAnchorElement).href)
      .filter(href => href && typeof href === 'string')
  })

  // ダウンロード系ファイル拡張子
  const SKIP_EXTENSIONS = /\.(pdf|zip|tar|gz|rar|7z|exe|dmg|msi|doc|docx|xls|xlsx|ppt|pptx|csv|mp3|mp4|avi|mov|wmv|flv|wav|ogg|webm|apk|iso|img)$/i

  // 認証・ログイン系パスパターン
  const AUTH_PATTERNS = /\/(login|logout|signin|signup|sign-in|sign-up|register|auth|oauth|sso|password|reset-password|forgot-password|account\/login|admin\/login|wp-login|user\/login)/i

  const seen = new Set<string>()
  const result: string[] = []

  for (const raw of rawLinks) {
    let parsed: URL
    try {
      parsed = new URL(raw, baseUrl)
    } catch {
      continue
    }

    // 同一ドメインチェック
    const linkDomain = parsed.hostname.replace(/^www\./, '')
    if (linkDomain !== baseDomain) continue

    // http/https のみ
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue

    // フラグメントを除去して正規化
    parsed.hash = ''
    const normalized = parsed.href

    // 自ページと同じURLはスキップ
    const baseNormalized = new URL(baseUrl)
    baseNormalized.hash = ''
    if (normalized === baseNormalized.href) continue

    // 重複スキップ
    if (seen.has(normalized)) continue
    seen.add(normalized)

    // ファイルダウンロードスキップ
    if (SKIP_EXTENSIONS.test(parsed.pathname)) continue

    // 認証ページスキップ
    if (AUTH_PATTERNS.test(parsed.pathname)) continue

    result.push(normalized)
  }

  return result
}
