/**
 * Fast programmatic HTML → TSX converter
 * No AI needed. Converts all 27k sections in minutes.
 * Run: npx tsx scripts/fast-tsx-convert.ts
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const RAW_HTML_BUCKET = 'corpus-raw-html'
const TSX_BUCKET = 'corpus-sanitized-html'
const BATCH_UPLOAD = 10 // parallel uploads

function htmlToTsx(html: string, blockFamily: string, domain: string): string {
  const componentName = blockFamily
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('') + 'Section'

  let tsx = html

  // Remove script tags
  tsx = tsx.replace(/<script[\s\S]*?<\/script>/gi, '')

  // Remove video/iframe (youtube, vimeo)
  tsx = tsx.replace(/<video[\s\S]*?<\/video>/gi, '')
  tsx = tsx.replace(/<iframe[\s\S]*?<\/iframe>/gi, '')

  // class → className
  tsx = tsx.replace(/\bclass=/g, 'className=')

  // for → htmlFor
  tsx = tsx.replace(/\bfor=/g, 'htmlFor=')

  // Self-closing tags
  tsx = tsx.replace(/<(img|br|hr|input|meta|link|source|area|col|embed|wbr)(\s[^>]*?)?\s*\/?>/gi,
    (_, tag, attrs) => `<${tag}${attrs || ''} />`)

  // style="..." → style={{...}} (basic conversion)
  tsx = tsx.replace(/style="([^"]*)"/g, (_, styleStr: string) => {
    try {
      const pairs = styleStr.split(';').filter(Boolean).map(pair => {
        const [prop, ...valParts] = pair.split(':')
        if (!prop || valParts.length === 0) return null
        const cssProp = prop.trim()
        const val = valParts.join(':').trim()
        // Convert CSS property to camelCase
        const jsProp = cssProp.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        // Check if value is numeric
        const numericVal = parseFloat(val)
        if (!isNaN(numericVal) && val.match(/^[\d.]+$/)) {
          return `${jsProp}: ${numericVal}`
        }
        return `${jsProp}: '${val.replace(/'/g, "\\'")}'`
      }).filter(Boolean)
      return `style={{${pairs.join(', ')}}}`
    } catch {
      return `style={{}}`
    }
  })

  // Fix boolean attributes
  tsx = tsx.replace(/\b(disabled|checked|selected|readonly|required|autofocus|autoplay|controls|loop|muted|hidden|novalidate|multiple|open)(?=[\s>\/])/gi,
    (attr) => `${attr}={true}`)
  // But undo if they already have a value
  tsx = tsx.replace(/(\w+)=\{true\}="([^"]*)"/g, '$1="$2"')

  // Fix common HTML entities
  tsx = tsx.replace(/&nbsp;/g, '{" "}')

  // tabindex → tabIndex
  tsx = tsx.replace(/\btabindex=/gi, 'tabIndex=')
  // colspan → colSpan
  tsx = tsx.replace(/\bcolspan=/gi, 'colSpan=')
  // rowspan → rowSpan
  tsx = tsx.replace(/\browspan=/gi, 'rowSpan=')
  // maxlength → maxLength
  tsx = tsx.replace(/\bmaxlength=/gi, 'maxLength=')
  // cellpadding → cellPadding
  tsx = tsx.replace(/\bcellpadding=/gi, 'cellPadding=')
  // cellspacing → cellSpacing
  tsx = tsx.replace(/\bcellspacing=/gi, 'cellSpacing=')
  // enctype → encType
  tsx = tsx.replace(/\benctype=/gi, 'encType=')
  // crossorigin → crossOrigin
  tsx = tsx.replace(/\bcrossorigin=/gi, 'crossOrigin=')
  // autocomplete → autoComplete
  tsx = tsx.replace(/\bautocomplete=/gi, 'autoComplete=')
  // charset → charSet
  tsx = tsx.replace(/\bcharset=/gi, 'charSet=')

  // Extract text content for editing guide
  const textMatches: string[] = []
  const textRe = />([^<]{10,})</g
  let m
  while ((m = textRe.exec(html)) !== null) {
    const text = m[1].trim()
    if (text.length > 10 && text.length < 200) {
      textMatches.push(text.slice(0, 80))
    }
    if (textMatches.length >= 5) break
  }

  // Extract image URLs
  const imgUrls: string[] = []
  const imgRe = /src=["']([^"']+)["']/g
  while ((m = imgRe.exec(html)) !== null) {
    if (m[1].match(/\.(jpg|jpeg|png|gif|svg|webp)/i)) {
      imgUrls.push(m[1].slice(0, 100))
    }
    if (imgUrls.length >= 5) break
  }

  // Build component
  const guide = `{/*
 * ========================================
 * 編集ガイド - ${componentName}
 * ========================================
 * ソース: ${domain}
 * 種別: ${blockFamily}
 *
 * 【テキスト一覧】
${textMatches.map(t => ` * - "${t}"`).join('\n') || ' * (テキストなし)'}
 *
 * 【画像パス一覧】
${imgUrls.map(u => ` * - ${u}`).join('\n') || ' * (画像なし)'}
 */}`

  return `import React from "react";

${guide}

const ${componentName}: React.FC = () => {
  return (
    <>
      ${tsx}
    </>
  );
};

export default ${componentName};
`
}

async function main() {
  console.log('=== Fast TSX Converter (programmatic, no AI) ===')

  // Fetch all sections
  console.log('Fetching sections...')
  const all: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from('source_sections')
      .select('id, raw_html_storage_path, block_family, site_id, source_sites!inner(normalized_domain)')
      .not('raw_html_storage_path', 'is', null)
      .order('created_at', { ascending: false })
      .range(from, from + 999)
    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`Total: ${all.length} sections`)

  let done = 0, success = 0, skipped = 0, errors = 0
  const startTime = Date.now()

  for (let i = 0; i < all.length; i += BATCH_UPLOAD) {
    const batch = all.slice(i, i + BATCH_UPLOAD)

    await Promise.allSettled(batch.map(async (section) => {
      try {
        // Check if already converted
        const tsxPath = `${section.id}/component.tsx`
        const { data: existing } = await sb.storage.from(TSX_BUCKET).download(tsxPath)
        if (existing) {
          skipped++
          done++
          return
        }

        // Download HTML
        const { data: htmlBlob, error: dlErr } = await sb.storage
          .from(RAW_HTML_BUCKET)
          .download(section.raw_html_storage_path)
        if (dlErr || !htmlBlob) {
          errors++
          done++
          return
        }
        const html = await htmlBlob.text()
        if (!html || html.trim().length < 30) {
          errors++
          done++
          return
        }

        // Convert
        const domain = section.source_sites?.normalized_domain || 'unknown'
        const tsx = htmlToTsx(html, section.block_family || 'content', domain)

        // Upload
        const buf = Buffer.from(tsx, 'utf-8')
        const { error: upErr } = await sb.storage.from(TSX_BUCKET).upload(tsxPath, buf, {
          contentType: 'text/plain',
          upsert: true
        })
        if (upErr) {
          console.error(`[UPLOAD] ${section.id}: ${upErr.message}`)
          errors++
        } else {
          success++
        }
        done++
      } catch (e: any) {
        console.error(`[ERR] ${section.id}: ${e.message?.slice(0, 60)}`)
        errors++
        done++
      }
    }))

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
    const rate = done > 0 ? (done / ((Date.now() - startTime) / 1000) * 60).toFixed(0) : '0'
    const remaining = all.length - done
    const etaMin = done > 0 ? Math.round(remaining / (done / ((Date.now() - startTime) / 1000)) / 60) : '?'
    if (done % 100 === 0 || done === all.length) {
      console.log(`[${done}/${all.length}] OK:${success} SKIP:${skipped} ERR:${errors} | ${elapsed}s | ${rate}/min | ETA:${etaMin}min`)
    }
  }

  console.log(`\n=== COMPLETE ===`)
  console.log(`Converted: ${success}`)
  console.log(`Skipped (already done): ${skipped}`)
  console.log(`Errors: ${errors}`)
  console.log(`Time: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`)
}

main().catch(console.error)
