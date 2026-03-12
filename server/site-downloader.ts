/**
 * Site Downloader
 * ユーザーの手順通りにサイトを完全コピーする。
 *
 * 1. Puppeteer で最終HTML取得（JS実行後DOM）
 * 2. HTML内の <link rel="stylesheet"> を全て直接ダウンロード
 * 3. HTML内の <img>, background-image 等の画像を全て直接ダウンロード
 * 4. CSS内の url() 画像・フォントも全て直接ダウンロード
 * 5. Google Fonts等のフォントCSSも取得
 * 6. 全アセットをSupabase Storageに保存
 * 7. HTML/CSS内のURLを全てStorage URLに書き換え
 *
 * curlで取れるものは全て取る。
 */
import type { Page } from 'puppeteer'
import { collectCSSChunks, resolveCSSUrls } from './network-recorder.js'
import { writeStoredFile, getStoredFileUrl } from './local-store.js'
import { HAS_SUPABASE, supabaseAdmin } from './supabase.js'
import { STORAGE_BUCKETS } from './storage-config.js'
import { logger } from './logger.js'

export interface DownloadedAsset {
  originalUrl: string
  storagePath: string
  signedUrl: string
  type: 'css' | 'image' | 'font' | 'js' | 'other'
  size: number
}

export interface SiteDownloadResult {
  finalHtml: string        // URL書き換え済みHTML
  cssFiles: DownloadedAsset[]
  imageFiles: DownloadedAsset[]
  fontFiles: DownloadedAsset[]
  allAssets: DownloadedAsset[]
  pageOrigin: string
  title: string
  lang: string
}

const SIGNED_URL_EXPIRY = 60 * 60 * 24 * 30 // 30日

/**
 * Promise に時間制限を設ける。超過時はエラーを投げる。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
  )
  return Promise.race([promise, timer])
}

/**
 * URLからバイナリデータを直接ダウンロード（curl相当）
 */
async function downloadFile(url: string): Promise<{ data: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    const arrayBuf = await res.arrayBuffer()
    return {
      data: Buffer.from(arrayBuf),
      contentType: res.headers.get('content-type') || 'application/octet-stream'
    }
  } catch {
    return null
  }
}

/**
 * URLをストレージパスに変換（安全なファイル名）
 */
function urlToStoragePath(baseDir: string, url: string, index: number): string {
  try {
    const u = new URL(url)
    // パスから拡張子を取得
    const pathname = u.pathname.replace(/^\/+/, '').replace(/[^a-zA-Z0-9._\-\/]/g, '_')
    const ext = pathname.match(/\.(css|js|png|jpg|jpeg|gif|svg|webp|avif|woff2?|ttf|eot|otf)$/i)?.[0] || ''
    const name = pathname.split('/').pop()?.slice(0, 80) || `asset_${index}${ext}`
    return `${baseDir}/${name}`
  } catch {
    return `${baseDir}/asset_${index}`
  }
}

/**
 * Supabase Storageにアップロードし、signed URLを取得
 */
async function uploadAndSign(
  bucket: string,
  path: string,
  data: Buffer,
  contentType: string
): Promise<string> {
  if (!HAS_SUPABASE) {
    await writeStoredFile(bucket, path, data, contentType)
    return getStoredFileUrl(bucket, path)
  }

  const { error } = await supabaseAdmin.storage.from(bucket).upload(path, data, { contentType, upsert: true })
  if (error) throw new Error(`Upload failed: ${error.message}`)

  const { data: signed } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, SIGNED_URL_EXPIRY)
  return signed?.signedUrl || ''
}

/**
 * HTML内からURL一覧を抽出する（Puppeteer page.evaluate内）
 */
async function extractUrlsFromPage(page: Page): Promise<{
  cssUrls: string[]
  imageUrls: string[]
  fontCssUrls: string[]
  scriptUrls: string[]
}> {
  return withTimeout(page.evaluate(() => {
    if (typeof (globalThis as any).__name === 'undefined') (globalThis as any).__name = (t: any) => t
    const cssUrls: string[] = []
    const imageUrls: string[] = []
    const fontCssUrls: string[] = []
    const scriptUrls: string[] = []

    // CSS: <link rel="stylesheet">
    document.querySelectorAll('link[rel="stylesheet"]').forEach(el => {
      const href = (el as HTMLLinkElement).href
      if (href) {
        cssUrls.push(href)
        // Google Fonts等はフォントCSS
        if (href.includes('fonts.googleapis.com') || href.includes('fonts.bunny.net')) {
          fontCssUrls.push(href)
        }
      }
    })

    // Images: <img src>, <source srcset>, background-image
    document.querySelectorAll('img').forEach(el => {
      const src = (el as HTMLImageElement).src
      if (src && !src.startsWith('data:')) imageUrls.push(src)
    })
    document.querySelectorAll('source').forEach(el => {
      const srcset = (el as HTMLSourceElement).srcset
      if (srcset) {
        srcset.split(',').forEach(s => {
          const url = s.trim().split(/\s+/)[0]
          if (url && !url.startsWith('data:')) imageUrls.push(url)
        })
      }
    })
    document.querySelectorAll('picture source').forEach(el => {
      const srcset = (el as HTMLSourceElement).srcset
      if (srcset) {
        srcset.split(',').forEach(s => {
          const url = s.trim().split(/\s+/)[0]
          if (url && !url.startsWith('data:')) imageUrls.push(url)
        })
      }
    })

    // background-image in inline styles
    document.querySelectorAll('[style]').forEach(el => {
      const style = (el as HTMLElement).style.backgroundImage
      if (style) {
        const match = style.match(/url\(["']?([^"')]+)["']?\)/)
        if (match && !match[1].startsWith('data:')) imageUrls.push(match[1])
      }
    })

    // OG images, favicons
    document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"], link[rel="icon"], link[rel="apple-touch-icon"]').forEach(el => {
      const url = (el as HTMLMetaElement).content || (el as HTMLLinkElement).href
      if (url && !url.startsWith('data:')) imageUrls.push(url)
    })

    // Scripts (optional)
    document.querySelectorAll('script[src]').forEach(el => {
      const src = (el as HTMLScriptElement).src
      // Skip analytics/GTM/tracking
      if (src && !src.includes('googletagmanager') && !src.includes('analytics') &&
          !src.includes('gtag') && !src.includes('facebook') && !src.includes('doubleclick')) {
        scriptUrls.push(src)
      }
    })

    return {
      cssUrls: [...new Set(cssUrls)],
      imageUrls: [...new Set(imageUrls)],
      fontCssUrls: [...new Set(fontCssUrls)],
      scriptUrls: [...new Set(scriptUrls)]
    }
  }), 10000, 'extractUrlsFromPage')
}

/**
 * CSS内のurl()参照を抽出する
 */
function extractUrlsFromCSS(css: string, cssBaseUrl: string): string[] {
  const urls: string[] = []
  const regex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi
  let match
  while ((match = regex.exec(css)) !== null) {
    let url = match[1].trim()
    if (url.startsWith('data:') || url.startsWith('#')) continue
    // 相対URL→絶対URL
    if (!url.startsWith('http')) {
      try {
        url = new URL(url, cssBaseUrl).href
      } catch { continue }
    }
    urls.push(url)
  }
  return [...new Set(urls)]
}

/**
 * メイン: サイトを完全ダウンロードする
 */
export async function downloadSite(
  page: Page,
  url: string,
  siteId: string,
  jobId: string
): Promise<SiteDownloadResult> {
  const baseDir = `${siteId}/${jobId}`
  const bucket = STORAGE_BUCKETS.RAW_HTML

  // Step 1: ページ取得（JS実行後）
  await page.setViewport({ width: 1440, height: 900 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })

  // Lazy-load scroll (timeout 30s to avoid hanging on infinite-scroll pages)
  await withTimeout(
    page.evaluate(async () => {
      if (typeof (globalThis as any).__name === 'undefined') (globalThis as any).__name = (t: any) => t
      const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
      const totalHeight = document.body.scrollHeight
      const step = window.innerHeight
      for (let y = 0; y < totalHeight; y += step) {
        window.scrollTo(0, y)
        await delay(200)
      }
      window.scrollTo(0, 0)
    }),
    30000,
    'lazy-scroll'
  )
  await new Promise(r => setTimeout(r, 1000))

  const finalUrl = page.url()
  const pageOrigin = new URL(finalUrl).origin
  const title = await page.title()
  const lang = await withTimeout(
    page.evaluate(() => document.documentElement.lang || 'ja'),
    10000, 'lang-detect'
  )

  // Step 2: URL抽出
  const { cssUrls, imageUrls, fontCssUrls } = await extractUrlsFromPage(page)
  logger.info('URLs extracted from page', { cssCount: cssUrls.length, imageCount: imageUrls.length, fontCssCount: fontCssUrls.length })

  const cssChunks = await collectCSSChunks(page)
  let allCssContent = cssChunks
    .map(chunk => `/* ${chunk.scope}: ${chunk.sourceUrl} */\n${resolveCSSUrls(chunk.cssText, chunk.baseUrl)}`)
    .join('\n\n')

  const allAssets: DownloadedAsset[] = []
  const urlMap = new Map<string, string>() // originalUrl → signedUrl

  // Step 3: CSS直接ダウンロード
  const cssFiles: DownloadedAsset[] = []

  for (let i = 0; i < cssUrls.length; i++) {
    const cssUrl = cssUrls[i]
    const file = await downloadFile(cssUrl)
    if (!file) { console.log(`  CSS skip (failed): ${cssUrl.slice(0, 80)}`); continue }

    const storagePath = urlToStoragePath(`${baseDir}/css`, cssUrl, i)
    try {
      const signedUrl = await uploadAndSign(bucket, storagePath, file.data, 'text/css')
      const asset: DownloadedAsset = { originalUrl: cssUrl, storagePath, signedUrl, type: 'css', size: file.data.length }
      cssFiles.push(asset)
      allAssets.push(asset)
      urlMap.set(cssUrl, signedUrl)
      console.log(`  CSS: ${cssUrl.split('/').pop()?.slice(0, 40)} (${Math.round(file.data.length / 1024)}KB)`)
    } catch (err: any) {
      console.log(`  CSS upload failed: ${err.message}`)
    }
  }

  // Step 4: CSS内の画像・フォントURLも抽出
  const cssInternalUrls = extractUrlsFromCSS(allCssContent, pageOrigin)

  // 全画像URL統合（HTML + CSS内）
  const allImageUrls = [...new Set([...imageUrls, ...cssInternalUrls.filter(u =>
    /\.(png|jpg|jpeg|gif|svg|webp|avif|ico)(\?|$)/i.test(u)
  )])]

  // フォントURL
  const allFontUrls = [...new Set(cssInternalUrls.filter(u =>
    /\.(woff2?|ttf|eot|otf)(\?|$)/i.test(u)
  ))]

  logger.info('Asset download starting', { totalImages: allImageUrls.length, totalFonts: allFontUrls.length })

  // Step 5: 画像ダウンロード（並列、最大30同時）
  const imageFiles: DownloadedAsset[] = []
  const imageChunks: string[][] = []
  for (let i = 0; i < allImageUrls.length; i += 30) {
    imageChunks.push(allImageUrls.slice(i, i + 30))
  }

  for (const chunk of imageChunks) {
    const results = await Promise.allSettled(chunk.map(async (imgUrl, idx) => {
      const file = await downloadFile(imgUrl)
      if (!file) return null

      const globalIdx = allImageUrls.indexOf(imgUrl)
      const storagePath = urlToStoragePath(`${baseDir}/img`, imgUrl, globalIdx)
      try {
        const signedUrl = await uploadAndSign(bucket, storagePath, file.data, file.contentType)
        const asset: DownloadedAsset = { originalUrl: imgUrl, storagePath, signedUrl, type: 'image', size: file.data.length }
        imageFiles.push(asset)
        allAssets.push(asset)
        urlMap.set(imgUrl, signedUrl)
        return asset
      } catch { return null }
    }))
  }
  logger.info('Images downloaded', { downloaded: imageFiles.length, total: allImageUrls.length })

  // Step 6: フォントダウンロード
  const fontFiles: DownloadedAsset[] = []
  for (let i = 0; i < allFontUrls.length; i++) {
    const fontUrl = allFontUrls[i]
    const file = await downloadFile(fontUrl)
    if (!file) continue

    const storagePath = urlToStoragePath(`${baseDir}/font`, fontUrl, i)
    try {
      const signedUrl = await uploadAndSign(bucket, storagePath, file.data, file.contentType)
      const asset: DownloadedAsset = { originalUrl: fontUrl, storagePath, signedUrl, type: 'font', size: file.data.length }
      fontFiles.push(asset)
      allAssets.push(asset)
      urlMap.set(fontUrl, signedUrl)
    } catch {}
  }

  // Google Fonts CSS内のフォントも取得
  for (const fontCssUrl of fontCssUrls) {
    const file = await downloadFile(fontCssUrl)
    if (!file) continue
    const fontCssText = file.data.toString('utf-8')
    const fontUrlsInCss = extractUrlsFromCSS(fontCssText, fontCssUrl)
    for (let i = 0; i < fontUrlsInCss.length; i++) {
      const fUrl = fontUrlsInCss[i]
      if (urlMap.has(fUrl)) continue
      const fFile = await downloadFile(fUrl)
      if (!fFile) continue
      const storagePath = urlToStoragePath(`${baseDir}/font`, fUrl, fontFiles.length + i)
      try {
        const signedUrl = await uploadAndSign(bucket, storagePath, fFile.data, fFile.contentType)
        urlMap.set(fUrl, signedUrl)
        fontFiles.push({ originalUrl: fUrl, storagePath, signedUrl, type: 'font', size: fFile.data.length })
      } catch {}
    }
  }
  logger.info('Fonts downloaded', { count: fontFiles.length })

  // Step 7: 最終HTMLを取得
  let finalHtml = await withTimeout(page.content(), 10000, 'page.content')

  // Step 8: 全てのURLを書き換え（HTML + CSS）
  // URLの長い順にソートして置換（部分一致を防ぐ）
  const sortedEntries = [...urlMap.entries()].sort((a, b) => b[0].length - a[0].length)

  // CSS内のURLも書き換え（CSS内は絶対URLなので直接置換でOK）
  let rewrittenCss = allCssContent
  for (const [originalUrl, signedUrl] of sortedEntries) {
    rewrittenCss = rewrittenCss.split(originalUrl).join(signedUrl)
  }

  // HTML: まず絶対URLの直接置換を試行
  for (const [originalUrl, signedUrl] of sortedEntries) {
    finalHtml = finalHtml.split(originalUrl).join(signedUrl)
  }

  // HTML: 相対/ルート相対URLをresolveしてurlMapで置換
  // page.content()は生の属性値を返すので、ブラウザ解決済みURLと一致しない場合がある
  const finalPageUrl = page.url()
  finalHtml = finalHtml.replace(
    /(src|href|srcset|poster|action)=(["'])(?!data:|https?:\/\/|\/\/|#|mailto:|tel:|javascript:)((?:(?!\2).)*)\2/gi,
    (match, attr, q, rawPath) => {
      try {
        const resolved = new URL(rawPath, finalPageUrl).href
        const signed = urlMap.get(resolved)
        if (signed) return `${attr}=${q}${signed}${q}`
      } catch {}
      // ダウンロードされなかったアセット — そのまま残す
      return match
    }
  )

  // background-image url() in inline styles
  finalHtml = finalHtml.replace(
    /url\(\s*(['"]?)(?!data:|https?:\/\/|\/\/)([^'")]+)\1\s*\)/gi,
    (match, q, rawPath) => {
      try {
        const resolved = new URL(rawPath, finalPageUrl).href
        const signed = urlMap.get(resolved)
        if (signed) return `url(${q}${signed}${q})`
      } catch {}
      return match
    }
  )

  // GTM, analytics削除
  finalHtml = finalHtml.replace(/<script[^>]*googletagmanager[^>]*>[\s\S]*?<\/script>/gi, '')
  finalHtml = finalHtml.replace(/<script[^>]*google-analytics[^>]*>[\s\S]*?<\/script>/gi, '')
  finalHtml = finalHtml.replace(/<script[^>]*gtag[^>]*>[\s\S]*?<\/script>/gi, '')
  finalHtml = finalHtml.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')

  // 書き換え済みCSSを保存
  const cssBundlePath = `${baseDir}/bundle.css`
  await uploadAndSign(bucket, cssBundlePath, Buffer.from(rewrittenCss, 'utf-8'), 'text/css')

  return {
    finalHtml,
    cssFiles,
    imageFiles,
    fontFiles,
    allAssets,
    pageOrigin,
    title,
    lang
  }
}
