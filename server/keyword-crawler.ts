/**
 * Keyword Crawler
 * キーワードからURLを自動取得してクロールキューに追加する。
 * 1. Claude でキーワードを関連ワードに拡張
 * 2. Google検索（Puppeteer）でco.jpサイトのURLを取得
 * 3. クロールキューに追加
 */
import { execFile } from 'child_process'
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
 * DuckDuckGo HTML版で検索してURLを取得（bot検出が緩い）
 */
async function searchWeb(keyword: string, maxResults: number = 20): Promise<string[]> {
  const urls: string[] = []

  try {
    // DuckDuckGo HTML版はJavaScript不要で軽量
    const query = encodeURIComponent(`${keyword} site:co.jp`)
    const searchUrl = `https://html.duckduckgo.com/html/?q=${query}`

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,en;q=0.9',
      }
    })

    if (!res.ok) {
      logger.warn('DuckDuckGo search failed', { keyword, status: res.status })
      return urls
    }

    const html = await res.text()

    // Extract URLs from DuckDuckGo results
    const urlRegex = /uddg=([^&"]+)/g
    let match
    while ((match = urlRegex.exec(html)) !== null && urls.length < maxResults) {
      try {
        const decoded = decodeURIComponent(match[1])
        const url = new URL(decoded)
        if (url.hostname.endsWith('.co.jp') || url.hostname.endsWith('.jp')) {
          const clean = `${url.protocol}//${url.hostname}`
          if (!urls.includes(clean)) {
            urls.push(clean)
          }
        }
      } catch {}
    }

    logger.info('Web search completed', { keyword, resultsFound: urls.length })
  } catch (err: any) {
    logger.warn('Web search failed', { keyword, error: err.message })
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

  // Step 2: 各キーワードでWeb検索
  const allUrls = new Set<string>()
  for (const kw of expandedKeywords.slice(0, 3)) {
    const urls = await searchWeb(kw, 15)
    urls.forEach(u => allUrls.add(u))

    // 短い間隔（DuckDuckGoはbot検出が緩い）
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000))
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
