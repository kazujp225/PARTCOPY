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
  const scopedCss = transformCss(css, scopeClass, keyframeMap, fontFaceSet, fontFaceCss).trim()

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
  if (keyframeMap.size === 0) return block

  return block.replace(/(animation(?:-name)?\s*:\s*)([^;]+)/gi, (_match, prefix, value) => {
    let rewrittenValue = String(value)

    for (const [originalName, scopedName] of keyframeMap.entries()) {
      const nameRe = new RegExp(`(^|[^-_a-zA-Z0-9])(${escapeRegExp(originalName)})(?=$|[^-_a-zA-Z0-9])`, 'g')
      rewrittenValue = rewrittenValue.replace(nameRe, (_innerMatch, boundary) => `${boundary}${scopedName}`)
    }

    return `${prefix}${rewrittenValue}`
  })
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
