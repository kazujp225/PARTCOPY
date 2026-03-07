/**
 * Capture Runner
 * Puppeteer page capture: goto, lazy-load, page.content(), screenshot
 */
import type { Page, Browser } from 'puppeteer'
import puppeteer from 'puppeteer'

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
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })

  // Trigger lazy-load by scrolling
  await page.evaluate(async () => {
    if (typeof (globalThis as any).__name === 'undefined') (globalThis as any).__name = (t: any) => t
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
    const totalHeight = document.body.scrollHeight
    const step = window.innerHeight
    for (let y = 0; y < totalHeight; y += step) {
      window.scrollTo(0, y)
      await delay(200)
    }
    window.scrollTo(0, 0)
  })
  await new Promise(r => setTimeout(r, 1000))

  // Get final rendered HTML (JS-executed DOM)
  const finalHtml = await page.content()
  const title = await page.title()
  const lang = await page.evaluate(() => document.documentElement.lang || 'ja')
  const finalUrl = page.url()

  // Full page screenshot (QA用)
  const fullScreenshot = await page.screenshot({ fullPage: true }) as Buffer

  return { finalUrl, title, lang, finalHtml, fullScreenshot, viewport: { width: 1440, height: 900 } }
}
