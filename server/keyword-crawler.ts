/**
 * Keyword Crawler
 * キーワードからURLを自動取得してクロールキューに追加する。
 * 1. Claude でキーワードを関連ワードに拡張
 * 2. Google検索（Puppeteer）でco.jpサイトのURLを取得
 * 3. クロールキューに追加
 */
import { execFile } from 'child_process'
import { launchBrowser } from './capture-runner.js'
import { appendToQueue, startAutoCrawler, isAutoCrawlActive } from './auto-crawler.js'
import { logger } from './logger.js'

/**
 * Claude にキーワードを拡張させる
 */
async function expandKeywords(keyword: string): Promise<string[]> {
  return new Promise((resolve) => {
    const prompt = `「${keyword}」に関連する日本企業のWebサイトを探すための検索キーワードを5つ生成してください。
ルール:
- 1行に1キーワード
- 日本語で
- 「〇〇会社」「〇〇サービス」のような具体的な業種名
- キーワードのみ出力（説明不要）`

    execFile('claude', ['-p', prompt], {
      maxBuffer: 512 * 1024,
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    }, (err, stdout) => {
      if (err) {
        logger.warn('Keyword expansion failed, using original', { keyword, error: err.message })
        resolve([keyword])
        return
      }
      const keywords = stdout.trim().split('\n')
        .map(line => line.replace(/^[\d\-\.\)]+\s*/, '').trim())
        .filter(line => line.length > 0 && line.length < 50)
      resolve(keywords.length > 0 ? keywords : [keyword])
    })
  })
}

/**
 * Google検索でco.jpサイトのURLを取得
 */
async function searchGoogle(keyword: string, maxResults: number = 20): Promise<string[]> {
  const browser = await launchBrowser()
  const urls: string[] = []

  try {
    const page = await browser.newPage()
    const query = encodeURIComponent(`${keyword} site:.co.jp`)
    const searchUrl = `https://www.google.co.jp/search?q=${query}&num=${maxResults}&hl=ja`

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })

    // Wait for results
    await page.waitForSelector('#search', { timeout: 5000 }).catch(() => {})

    // Extract URLs from search results
    const results = await page.evaluate(() => {
      const links: string[] = []
      document.querySelectorAll('#search a[href]').forEach(a => {
        const href = (a as HTMLAnchorElement).href
        if (href && href.includes('.co.jp') && !href.includes('google.') && !href.includes('cache:')) {
          try {
            const url = new URL(href)
            // Only keep homepage or main pages
            const clean = `${url.protocol}//${url.hostname}`
            if (!links.includes(clean)) {
              links.push(clean)
            }
          } catch {}
        }
      })
      return links
    })

    urls.push(...results)
    logger.info('Google search completed', { keyword, resultsFound: results.length })
  } catch (err: any) {
    logger.warn('Google search failed', { keyword, error: err.message })
  } finally {
    await browser.close().catch(() => {})
  }

  return urls
}

/**
 * キーワードからURLを検索してクロールキューに追加
 */
export async function searchAndQueue(keyword: string): Promise<{
  expandedKeywords: string[]
  urls: string[]
  queued: number
}> {
  logger.info('Keyword search started', { keyword })

  // Step 1: Claude でキーワード拡張
  const expandedKeywords = await expandKeywords(keyword)
  logger.info('Keywords expanded', { original: keyword, expanded: expandedKeywords })

  // Step 2: 各キーワードでGoogle検索
  const allUrls = new Set<string>()
  for (const kw of expandedKeywords.slice(0, 5)) {
    const urls = await searchGoogle(kw, 10)
    urls.forEach(u => allUrls.add(u))

    // 検索間隔を空ける（Bot検出回避）
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000))
  }

  const uniqueUrls = [...allUrls]
  logger.info('URLs collected', { keyword, totalUrls: uniqueUrls.length })

  // Step 3: クロールキューに追加
  const queued = await appendToQueue(uniqueUrls)

  // Auto-crawlerを開始
  if (!isAutoCrawlActive() && queued > 0) {
    startAutoCrawler()
  }

  return {
    expandedKeywords,
    urls: uniqueUrls,
    queued
  }
}
