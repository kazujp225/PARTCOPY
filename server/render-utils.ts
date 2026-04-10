import { STORAGE_BUCKETS } from './storage-config.js'

const CSS_URL_RE = /url\(\s*(['"]?)([^"'()]+)\1\s*\)/gi
const HTML_ASSET_ATTR_RE = /(src|poster)=(["'])(.*?)\2/gi
const HTML_SRCSET_RE = /srcset=(["'])(.*?)\1/gi
const HTML_STYLE_ATTR_RE = /style=(["'])(.*?)\1/gi

const NESTED_AT_RULES = new Set([
  'container',
  'document',
  'layer',
  'media',
  'scope',
  'starting-style',
  'supports'
])

export function createSectionScopeClass(sectionId: string) {
  const safeId = sectionId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return `pc-sec-${safeId || 'section'}`
}

export function rewriteCssAssetUrls(css: string, cssBundlePath?: string | null) {
  if (!css || !cssBundlePath) return css

  const assetBase = `/assets/${cssBundlePath.replace(/\/[^/]+$/, '/')}`
  return css.replace(CSS_URL_RE, (match, quote, rawPath) => {
    const trimmed = rawPath.trim()
    if (!trimmed || /^(data:|https?:\/\/|\/\/|\/assets\/)/i.test(trimmed)) {
      return match
    }
    return `url(${quote}${assetBase}${trimmed}${quote})`
  })
}

export function collectCssAssetUrls(css: string) {
  const urls: string[] = []

  css.replace(CSS_URL_RE, (_match, _quote, rawPath) => {
    const trimmed = String(rawPath || '').trim()
    if (!shouldIgnoreAssetUrl(trimmed)) urls.push(trimmed)
    return _match
  })

  return dedupeStrings(urls)
}

export function rewriteCssUrls(css: string, replacer: (url: string) => string | undefined) {
  return css.replace(CSS_URL_RE, (match, quote, rawPath) => {
    const trimmed = String(rawPath || '').trim()
    if (shouldIgnoreAssetUrl(trimmed)) return match
    const rewritten = replacer(trimmed)
    if (!rewritten) return match
    return `url(${quote}${rewritten}${quote})`
  })
}

export function collectHtmlAssetUrls(html: string) {
  const urls: string[] = []

  html.replace(HTML_ASSET_ATTR_RE, (match, _attr, _quote, rawPath) => {
    const trimmed = String(rawPath || '').trim()
    if (!shouldIgnoreAssetUrl(trimmed)) urls.push(trimmed)
    return match
  })

  html.replace(HTML_SRCSET_RE, (match, _quote, rawValue) => {
    for (const entry of splitSrcset(String(rawValue || ''))) {
      if (!shouldIgnoreAssetUrl(entry.url)) urls.push(entry.url)
    }
    return match
  })

  html.replace(HTML_STYLE_ATTR_RE, (match, _quote, rawValue) => {
    urls.push(...collectCssAssetUrls(String(rawValue || '')))
    return match
  })

  return dedupeStrings(urls)
}

export function rewriteHtmlAssetUrls(html: string, replacer: (url: string) => string | undefined) {
  let result = html.replace(HTML_ASSET_ATTR_RE, (match, attr, quote, rawPath) => {
    const trimmed = String(rawPath || '').trim()
    if (shouldIgnoreAssetUrl(trimmed)) return match
    const rewritten = replacer(trimmed)
    if (!rewritten) return match
    return `${attr}=${quote}${rewritten}${quote}`
  })

  result = result.replace(HTML_SRCSET_RE, (match, quote, rawValue) => {
    const rewritten = splitSrcset(String(rawValue || ''))
      .map((entry) => {
        if (shouldIgnoreAssetUrl(entry.url)) return entry.raw
        const nextUrl = replacer(entry.url)
        if (!nextUrl) return entry.raw
        return entry.descriptor ? `${nextUrl} ${entry.descriptor}` : nextUrl
      })
      .join(', ')

    return `srcset=${quote}${rewritten}${quote}`
  })

  result = result.replace(HTML_STYLE_ATTR_RE, (match, quote, rawValue) => {
    const rewritten = rewriteCssUrls(String(rawValue || ''), replacer)
    return `style=${quote}${rewritten}${quote}`
  })

  return result
}

export function parseStoredAssetUrl(url: string) {
  const trimmed = url.trim()
  if (!trimmed) return null

  const localAssetPath = extractLocalAssetPath(trimmed)
  if (localAssetPath) {
    return {
      bucket: STORAGE_BUCKETS.RAW_HTML,
      storagePath: localAssetPath
    }
  }

  try {
    const parsed = new URL(trimmed)
    const nestedLocalAssetPath = extractLocalAssetPath(parsed.pathname)
    if (nestedLocalAssetPath) {
      return {
        bucket: STORAGE_BUCKETS.RAW_HTML,
        storagePath: nestedLocalAssetPath
      }
    }

    const match = parsed.pathname.match(/\/storage\/v1\/object\/(?:sign|public|authenticated)\/([^/]+)\/(.+)$/i)
    if (!match) return null

    return {
      bucket: decodeURIComponent(match[1]),
      storagePath: decodeURIComponent(match[2])
    }
  } catch {
    return null
  }
}

export function scopeCss(css: string, scopeClass: string) {
  const fontFaceCss: string[] = []
  const fontFaceSet = new Set<string>()
  const keyframeMap = collectKeyframeMap(css, scopeClass)
  let scopedCss = transformCss(css, scopeClass, keyframeMap, fontFaceSet, fontFaceCss).trim()

  // CSS変数をセクション固有のスコープに書き換え
  scopedCss = scopeCssVariables(scopedCss, scopeClass)

  return {
    scopedCss,
    fontFaceCss
  }
}

function shouldIgnoreAssetUrl(url: string) {
  return !url || /^(data:|#|mailto:|tel:|javascript:)/i.test(url)
}

function dedupeStrings(values: string[]) {
  return [...new Set(values)]
}

function splitSrcset(srcset: string) {
  return srcset
    .split(',')
    .map((segment) => {
      const raw = segment.trim()
      if (!raw) {
        return { raw: '', url: '', descriptor: '' }
      }

      const parts = raw.split(/\s+/)
      return {
        raw,
        url: parts[0] || '',
        descriptor: parts.slice(1).join(' ')
      }
    })
    .filter((entry) => entry.raw)
}

function extractLocalAssetPath(urlOrPath: string) {
  const match = urlOrPath.match(/^\/assets\/(.+)$/)
  return match ? decodeURIComponent(match[1]) : null
}

function collectKeyframeMap(css: string, scopeClass: string, map = new Map<string, string>()) {
  let index = 0

  while (index < css.length) {
    if (css.startsWith('/*', index)) {
      index = skipComment(css, index)
      continue
    }

    if (css[index] !== '@') {
      index += 1
      continue
    }

    const boundaryIndex = findTopLevelBoundary(css, index, ['{', ';'])
    if (boundaryIndex === -1) break

    if (css[boundaryIndex] === ';') {
      index = boundaryIndex + 1
      continue
    }

    const header = css.slice(index, boundaryIndex).trim()
    const atRuleName = getAtRuleName(header)
    const closeIndex = findMatchingBrace(css, boundaryIndex)
    if (closeIndex === -1) break

    const body = css.slice(boundaryIndex + 1, closeIndex)
    if (isKeyframesRule(atRuleName)) {
      const keyframeName = getKeyframesName(header)
      if (keyframeName) {
        map.set(keyframeName, `${scopeClass}-${keyframeName}`)
      }
    } else if (NESTED_AT_RULES.has(atRuleName)) {
      collectKeyframeMap(body, scopeClass, map)
    }

    index = closeIndex + 1
  }

  return map
}

function transformCss(
  css: string,
  scopeClass: string,
  keyframeMap: Map<string, string>,
  fontFaceSet: Set<string>,
  fontFaceCss: string[]
) {
  let index = 0
  let output = ''

  while (index < css.length) {
    if (css.startsWith('/*', index)) {
      const end = skipComment(css, index)
      output += css.slice(index, end)
      index = end
      continue
    }

    const char = css[index]
    if (/\s/.test(char)) {
      output += char
      index += 1
      continue
    }

    if (char === '@') {
      const boundaryIndex = findTopLevelBoundary(css, index, ['{', ';'])
      if (boundaryIndex === -1) {
        output += css.slice(index)
        break
      }

      if (css[boundaryIndex] === ';') {
        output += css.slice(index, boundaryIndex + 1)
        index = boundaryIndex + 1
        continue
      }

      const header = css.slice(index, boundaryIndex).trim()
      const atRuleName = getAtRuleName(header)
      const closeIndex = findMatchingBrace(css, boundaryIndex)
      if (closeIndex === -1) {
        output += css.slice(index)
        break
      }

      const body = css.slice(boundaryIndex + 1, closeIndex)

      if (atRuleName === 'font-face') {
        const block = `${header}{${rewriteAnimationNamesInDeclarations(body, keyframeMap)}}`
        const normalized = normalizeCssBlock(block)
        if (!fontFaceSet.has(normalized)) {
          fontFaceSet.add(normalized)
          fontFaceCss.push(block.trim())
        }
      } else if (isKeyframesRule(atRuleName)) {
        output += `${renameKeyframesHeader(header, keyframeMap)}{${body}}`
      } else if (NESTED_AT_RULES.has(atRuleName)) {
        output += `${header}{${transformCss(body, scopeClass, keyframeMap, fontFaceSet, fontFaceCss)}}`
      } else {
        output += `${header}{${rewriteAnimationNamesInDeclarations(body, keyframeMap)}}`
      }

      index = closeIndex + 1
      continue
    }

    const openIndex = findTopLevelBoundary(css, index, ['{'])
    if (openIndex === -1) {
      output += css.slice(index)
      break
    }

    const closeIndex = findMatchingBrace(css, openIndex)
    if (closeIndex === -1) {
      output += css.slice(index)
      break
    }

    const selectorText = css.slice(index, openIndex).trim()
    const body = css.slice(openIndex + 1, closeIndex)
    const scopedSelector = scopeSelectorList(selectorText, scopeClass)
    output += `${scopedSelector}{${rewriteAnimationNamesInDeclarations(body, keyframeMap)}}`
    index = closeIndex + 1
  }

  return output
}

function scopeSelectorList(selectorText: string, scopeClass: string) {
  return splitTopLevelSelectors(selectorText)
    .map((selector) => scopeSelector(selector, scopeClass))
    .join(', ')
}

function scopeSelector(selector: string, scopeClass: string) {
  const scope = `.${scopeClass}`
  let trimmed = selector.trim()

  if (!trimmed) return trimmed
  if (trimmed === '*') return `${scope} *`

  if (/^(html|body|:root)(?=[.#[:\s>+~]|$)/i.test(trimmed)) {
    const boundary = findCompoundBoundary(trimmed)
    trimmed = `${scope}${trimmed.slice(boundary)}`
  } else {
    trimmed = trimmed.replace(/(^|[\s>+~])(?:html|body|:root)(?=(?:[\s>+~]|$))/gi, '$1')
    trimmed = trimmed.trim()
  }

  if (!trimmed) return scope
  if (trimmed.startsWith(scope)) return trimmed
  if (trimmed.startsWith('*')) return `${scope} ${trimmed}`
  if (/^[>+~]/.test(trimmed)) return `${scope}${trimmed}`

  return `${scope} ${trimmed}`
}

function splitTopLevelSelectors(selectorText: string) {
  const selectors: string[] = []
  let current = ''
  let quote = ''
  let parenDepth = 0
  let bracketDepth = 0

  for (let index = 0; index < selectorText.length; index += 1) {
    const char = selectorText[index]
    const next = selectorText[index + 1]

    if (quote) {
      current += char
      if (char === '\\') {
        current += next || ''
        index += 1
      } else if (char === quote) {
        quote = ''
      }
      continue
    }

    if (char === '/' && next === '*') {
      const end = selectorText.indexOf('*/', index + 2)
      current += end === -1 ? selectorText.slice(index) : selectorText.slice(index, end + 2)
      if (end === -1) break
      index = end + 1
      continue
    }

    if (char === '"' || char === '\'') {
      quote = char
      current += char
      continue
    }

    if (char === '(') parenDepth += 1
    if (char === ')') parenDepth = Math.max(parenDepth - 1, 0)
    if (char === '[') bracketDepth += 1
    if (char === ']') bracketDepth = Math.max(bracketDepth - 1, 0)

    if (char === ',' && parenDepth === 0 && bracketDepth === 0) {
      selectors.push(current)
      current = ''
      continue
    }

    current += char
  }

  selectors.push(current)
  return selectors.filter((selector) => selector.trim().length > 0)
}

function rewriteAnimationNamesInDeclarations(block: string, keyframeMap: Map<string, string>) {
  let result = block

  // Rewrite animation names
  if (keyframeMap.size > 0) {
    result = result.replace(/(animation(?:-name)?\s*:\s*)([^;]+)/gi, (_match, prefix, value) => {
      let rewrittenValue = String(value)

      for (const [originalName, scopedName] of keyframeMap.entries()) {
        const nameRe = new RegExp(`(^|[^-_a-zA-Z0-9])(${escapeRegExp(originalName)})(?=$|[^-_a-zA-Z0-9])`, 'g')
        rewrittenValue = rewrittenValue.replace(nameRe, (_innerMatch, boundary) => `${boundary}${scopedName}`)
      }

      return `${prefix}${rewrittenValue}`
    })
  }

  return result
}

/**
 * CSS変数をセクション固有のプレフィックス付きにスコープする。
 * --foo → --pc-{hash}-foo（宣言と参照の両方）
 * ブラウザ標準の変数（--tw-, --bs- 等のフレームワーク変数も含む）全てをスコープ。
 */
/**
 * HTML内の inline style に含まれるCSS変数参照もスコープする。
 * style="color: var(--primary)" → style="color: var(--pc-hash-primary)"
 */
export function scopeHtmlInlineVars(html: string, scopeClass: string): string {
  const hash = scopeClass.replace('pc-sec-', '').slice(0, 8)
  const prefix = `--pc-${hash}-`

  // style属性内の var(--xxx) を書き換え — フレームワーク変数は除外
  return html.replace(/style=(["'])([\s\S]*?)\1/gi, (match, quote, styleContent) => {
    const rewritten = styleContent.replace(/var\(\s*(--[\w-]+)/g, (_m: string, varName: string) => {
      if (isFrameworkVar(varName)) return `var(${varName}`
      return `var(${prefix}${varName.slice(2)}`
    })
    if (rewritten === styleContent) return match
    return `style=${quote}${rewritten}${quote}`
  })
}

/**
 * Strip video and external video iframe elements from HTML string.
 * Used at export/render time to remove video content that cannot be edited.
 */
export function stripVideoElements(html: string): string {
  // Remove <video>...</video> blocks (including nested <source> elements)
  let result = html.replace(/<video\b[\s\S]*?<\/video>/gi, '')
  // Remove self-closing <video .../>
  result = result.replace(/<video\b[^>]*\/>/gi, '')
  // Remove YouTube iframes
  result = result.replace(/<iframe\b[^>]*\bsrc=["'][^"']*youtube[^"']*["'][^>]*>[\s\S]*?<\/iframe>/gi, '')
  result = result.replace(/<iframe\b[^>]*\bsrc=["'][^"']*youtube[^"']*["'][^>]*\/>/gi, '')
  // Remove Vimeo iframes
  result = result.replace(/<iframe\b[^>]*\bsrc=["'][^"']*vimeo[^"']*["'][^>]*>[\s\S]*?<\/iframe>/gi, '')
  result = result.replace(/<iframe\b[^>]*\bsrc=["'][^"']*vimeo[^"']*["'][^>]*\/>/gi, '')
  // Remove Dailymotion iframes
  result = result.replace(/<iframe\b[^>]*\bsrc=["'][^"']*dailymotion[^"']*["'][^>]*>[\s\S]*?<\/iframe>/gi, '')
  result = result.replace(/<iframe\b[^>]*\bsrc=["'][^"']*dailymotion[^"']*["'][^>]*\/>/gi, '')
  // Clean up empty wrapper divs that only contained video (optional, minimal cleanup)
  return result
}

/**
 * Extract CSS-relevant tokens (class names, IDs, tag names) from HTML.
 * Used to filter CSS rules to only those relevant to a section.
 */
export function extractHtmlTokens(html: string): { classes: Set<string>, ids: Set<string>, tags: Set<string> } {
  const classes = new Set<string>()
  const ids = new Set<string>()
  const tags = new Set<string>()

  const classRe = /class(?:Name)?=["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = classRe.exec(html)) !== null) {
    for (const token of m[1].split(/\s+/)) {
      if (token) classes.add(token)
    }
  }

  const idRe = /id=["']([^"']+)["']/gi
  while ((m = idRe.exec(html)) !== null) {
    if (m[1]) ids.add(m[1])
  }

  const tagRe = /<([a-z][a-z0-9]*)\b/gi
  while ((m = tagRe.exec(html)) !== null) {
    tags.add(m[1].toLowerCase())
  }

  return { classes, ids, tags }
}

/**
 * Filter CSS to only include rules relevant to the given HTML tokens.
 * Keeps @font-face, @keyframes, @import unconditionally.
 * For regular rules, checks if any selector references a class, ID, or tag from the tokens.
 * For nested @media/@supports, recursively filters and keeps if any inner rules match.
 */
export function filterCssForSection(css: string, tokens: { classes: Set<string>, ids: Set<string>, tags: Set<string> }): string {
  let index = 0
  let output = ''

  while (index < css.length) {
    if (css.startsWith('/*', index)) {
      const end = skipComment(css, index)
      output += css.slice(index, end)
      index = end
      continue
    }

    const char = css[index]

    if (/\s/.test(char)) {
      output += char
      index += 1
      continue
    }

    if (char === '@') {
      const boundaryIndex = findTopLevelBoundary(css, index, ['{', ';'])
      if (boundaryIndex === -1) {
        output += css.slice(index)
        break
      }

      if (css[boundaryIndex] === ';') {
        output += css.slice(index, boundaryIndex + 1)
        index = boundaryIndex + 1
        continue
      }

      const header = css.slice(index, boundaryIndex).trim()
      const atRuleName = getAtRuleName(header)
      const closeIndex = findMatchingBrace(css, boundaryIndex)
      if (closeIndex === -1) {
        output += css.slice(index)
        break
      }

      const body = css.slice(boundaryIndex + 1, closeIndex)

      if (atRuleName === 'font-face' || isKeyframesRule(atRuleName)) {
        output += css.slice(index, closeIndex + 1)
      } else if (NESTED_AT_RULES.has(atRuleName)) {
        const filteredBody = filterCssForSection(body, tokens)
        if (filteredBody.trim()) {
          output += `${header}{${filteredBody}}`
        }
      } else {
        output += css.slice(index, closeIndex + 1)
      }

      index = closeIndex + 1
      continue
    }

    const openIndex = findTopLevelBoundary(css, index, ['{'])
    if (openIndex === -1) {
      output += css.slice(index)
      break
    }

    const closeIndex = findMatchingBrace(css, openIndex)
    if (closeIndex === -1) {
      output += css.slice(index)
      break
    }

    const selectorText = css.slice(index, openIndex).trim()
    const body = css.slice(openIndex + 1, closeIndex)

    if (selectorMatchesTokens(selectorText, tokens)) {
      output += `${selectorText}{${body}}`
    }

    index = closeIndex + 1
  }

  return output
}

function selectorMatchesTokens(selectorText: string, tokens: { classes: Set<string>, ids: Set<string>, tags: Set<string> }): boolean {
  const selectors = splitTopLevelSelectors(selectorText)

  for (const selector of selectors) {
    const trimmed = selector.trim()
    if (!trimmed) continue

    if (trimmed === '*' || trimmed === ':root') return true

    const classRe = /\.(-?[a-zA-Z_][\w-]*)/g
    let m: RegExpExecArray | null
    while ((m = classRe.exec(trimmed)) !== null) {
      if (tokens.classes.has(m[1])) return true
    }

    const idRe = /#(-?[a-zA-Z_][\w-]*)/g
    while ((m = idRe.exec(trimmed)) !== null) {
      if (tokens.ids.has(m[1])) return true
    }

    const tagRe = /(?:^|[\s>+~])([a-zA-Z][a-zA-Z0-9]*)/g
    while ((m = tagRe.exec(trimmed)) !== null) {
      if (tokens.tags.has(m[1].toLowerCase())) return true
    }
  }

  return false
}

// フレームワーク由来のCSS変数プレフィックス — これらはリネームすると壊れる
const FRAMEWORK_VAR_PREFIXES = [
  '--tw-',       // Tailwind CSS
  '--bs-',       // Bootstrap
  '--chakra-',   // Chakra UI
  '--mantine-',  // Mantine
  '--mdc-',      // Material Design Components
  '--wp-',       // WordPress
  '--wc-',       // Web Components (Lit, etc.)
  '--sl-',       // Shoelace
  '--spectrum-', // Adobe Spectrum
]

function isFrameworkVar(varName: string): boolean {
  return FRAMEWORK_VAR_PREFIXES.some(p => varName.startsWith(p))
}

function scopeCssVariables(css: string, scopeClass: string): string {
  // scopeClassからハッシュ部分を抽出（pc-sec-xxxx → xxxx の先頭8文字）
  const hash = scopeClass.replace('pc-sec-', '').slice(0, 8)
  const prefix = `--pc-${hash}-`

  // 変数を収集（宣言側）— フレームワーク変数は除外
  const varNames = new Set<string>()
  css.replace(/(--[\w-]+)\s*:/g, (_m, name) => {
    if (!isFrameworkVar(name)) {
      varNames.add(name)
    }
    return _m
  })

  if (varNames.size === 0) return css

  let result = css

  // 長い名前から順にリプレース（--primary-color を --primary より先に処理）
  const sortedVars = [...varNames].sort((a, b) => b.length - a.length)

  for (const varName of sortedVars) {
    const scopedName = prefix + varName.slice(2) // --foo → --pc-{hash}-foo
    const escaped = escapeRegExp(varName)

    // 宣言: --foo: value → --pc-hash-foo: value
    result = result.replace(new RegExp(`(${escaped})(\\s*:)`, 'g'), `${scopedName}$2`)

    // 参照: var(--foo) → var(--pc-hash-foo)
    result = result.replace(new RegExp(`var\\(\\s*${escaped}(?=[,)])`, 'g'), `var(${scopedName}`)
  }

  return result
}

function renameKeyframesHeader(header: string, keyframeMap: Map<string, string>) {
  return header.replace(/^(@(?:-\w+-)?keyframes\s+)([^{\s]+)/i, (_match, prefix, name) => {
    return `${prefix}${keyframeMap.get(name) || name}`
  })
}

function getAtRuleName(header: string) {
  const match = header.match(/^@([-\w]+)/)
  return match?.[1]?.toLowerCase() || ''
}

function getKeyframesName(header: string) {
  const match = header.match(/^@(?:-\w+-)?keyframes\s+([^{\s]+)/i)
  return match?.[1] || ''
}

function isKeyframesRule(atRuleName: string) {
  return /keyframes$/i.test(atRuleName)
}

function normalizeCssBlock(block: string) {
  return block.replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function skipComment(input: string, startIndex: number) {
  const end = input.indexOf('*/', startIndex + 2)
  return end === -1 ? input.length : end + 2
}

function findCompoundBoundary(selector: string) {
  let quote = ''
  let parenDepth = 0
  let bracketDepth = 0

  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]
    const next = selector[index + 1]

    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = ''
      }
      continue
    }

    if (char === '/' && next === '*') {
      index = skipComment(selector, index) - 1
      continue
    }

    if (char === '"' || char === '\'') {
      quote = char
      continue
    }

    if (char === '(') parenDepth += 1
    if (char === ')') parenDepth = Math.max(parenDepth - 1, 0)
    if (char === '[') bracketDepth += 1
    if (char === ']') bracketDepth = Math.max(bracketDepth - 1, 0)

    if (parenDepth === 0 && bracketDepth === 0 && (/\s/.test(char) || /[>+~]/.test(char))) {
      return index
    }
  }

  return selector.length
}

function findTopLevelBoundary(input: string, startIndex: number, targets: string[]) {
  const targetSet = new Set(targets)
  let quote = ''
  let parenDepth = 0
  let bracketDepth = 0

  for (let index = startIndex; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = ''
      }
      continue
    }

    if (char === '/' && next === '*') {
      index = skipComment(input, index) - 1
      continue
    }

    if (char === '"' || char === '\'') {
      quote = char
      continue
    }

    if (char === '(') parenDepth += 1
    if (char === ')') parenDepth = Math.max(parenDepth - 1, 0)
    if (char === '[') bracketDepth += 1
    if (char === ']') bracketDepth = Math.max(bracketDepth - 1, 0)

    if (parenDepth === 0 && bracketDepth === 0 && targetSet.has(char)) {
      return index
    }
  }

  return -1
}

function findMatchingBrace(input: string, openIndex: number) {
  let quote = ''
  let depth = 0

  for (let index = openIndex; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = ''
      }
      continue
    }

    if (char === '/' && next === '*') {
      index = skipComment(input, index) - 1
      continue
    }

    if (char === '"' || char === '\'') {
      quote = char
      continue
    }

    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return -1
}
