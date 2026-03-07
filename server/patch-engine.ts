/**
 * Patch Engine
 * section_patches を base HTML に適用して、編集済み HTML を生成する。
 *
 * パッチは stable_key をアドレスとして、DOM ノードを操作する。
 * ブラウザ側（フロント）とサーバー側の両方で使えるように、
 * 純粋な文字列/JSON操作で実装する。
 */

export interface Patch {
  nodeStableKey: string
  op: PatchOp
  payload: Record<string, any>
}

export type PatchOp =
  | 'set_text'       // { text: string }
  | 'set_attr'       // { attr: string, value: string }
  | 'replace_asset'  // { src: string, alt?: string }
  | 'remove_node'    // {}
  | 'insert_after'   // { html: string }
  | 'move_node'      // { targetKey: string, position: 'before' | 'after' }
  | 'set_style_token' // { property: string, value: string }
  | 'set_class'      // { add?: string[], remove?: string[] }

/**
 * パッチ適用結果の型。
 * フロント側で DOM に直接適用する場合と、
 * サーバー側で HTML 文字列を返す場合がある。
 */
export interface PatchApplication {
  stableKey: string
  op: PatchOp
  success: boolean
  error?: string
}

/**
 * パッチ操作のバリデーション
 */
export function validatePatch(patch: Patch): string | null {
  if (!patch.nodeStableKey) return 'nodeStableKey is required'
  if (!patch.op) return 'op is required'

  switch (patch.op) {
    case 'set_text':
      if (typeof patch.payload?.text !== 'string') return 'set_text requires payload.text'
      break
    case 'set_attr':
      if (!patch.payload?.attr) return 'set_attr requires payload.attr'
      if (typeof patch.payload?.value !== 'string') return 'set_attr requires payload.value'
      // 危険属性のブロック
      if (/^on/i.test(patch.payload.attr)) return 'Event handler attributes are not allowed'
      break
    case 'replace_asset':
      if (!patch.payload?.src) return 'replace_asset requires payload.src'
      break
    case 'remove_node':
      break
    case 'insert_after':
      if (!patch.payload?.html) return 'insert_after requires payload.html'
      // script injection 防止
      if (/<script/i.test(patch.payload.html)) return 'Script injection is not allowed'
      break
    case 'move_node':
      if (!patch.payload?.targetKey) return 'move_node requires payload.targetKey'
      break
    case 'set_style_token':
      if (!patch.payload?.property) return 'set_style_token requires payload.property'
      break
    case 'set_class':
      break
    default:
      return `Unknown op: ${patch.op}`
  }
  return null
}

/**
 * パッチセットを正規化してソートする。
 * 同じノードへの複数パッチは、後のものが優先。
 */
export function normalizePatches(patches: Patch[]): Patch[] {
  // order_index 順にソート（呼び出し側で設定済み想定）
  // 同じキー＋同じopの場合、後勝ち
  const seen = new Map<string, number>()
  const result: Patch[] = []

  for (let i = patches.length - 1; i >= 0; i--) {
    const key = `${patches[i].nodeStableKey}::${patches[i].op}`
    if (!seen.has(key)) {
      seen.set(key, i)
      result.unshift(patches[i])
    }
  }
  return result
}

/**
 * フロントエンド側で使用する: data-pc-key 属性でノードを探し、パッチを適用する。
 * これは EditableSourceFrame 内の iframe contentDocument に対して実行される。
 */
export function applyPatchToDOM(doc: Document, patch: Patch): PatchApplication {
  const el = doc.querySelector(`[data-pc-key="${patch.nodeStableKey}"]`) as HTMLElement | null
  if (!el) {
    return { stableKey: patch.nodeStableKey, op: patch.op, success: false, error: 'Node not found' }
  }

  try {
    switch (patch.op) {
      case 'set_text':
        el.textContent = patch.payload.text
        break
      case 'set_attr':
        el.setAttribute(patch.payload.attr, patch.payload.value)
        break
      case 'replace_asset':
        if (el.tagName === 'IMG') {
          (el as HTMLImageElement).src = patch.payload.src
          if (patch.payload.alt) (el as HTMLImageElement).alt = patch.payload.alt
        } else if (el.style.backgroundImage) {
          el.style.backgroundImage = `url(${patch.payload.src})`
        }
        break
      case 'remove_node':
        el.remove()
        break
      case 'insert_after':
        el.insertAdjacentHTML('afterend', patch.payload.html)
        break
      case 'set_style_token':
        el.style.setProperty(patch.payload.property, patch.payload.value)
        break
      case 'set_class':
        if (patch.payload.add) patch.payload.add.forEach((c: string) => el.classList.add(c))
        if (patch.payload.remove) patch.payload.remove.forEach((c: string) => el.classList.remove(c))
        break
      default:
        return { stableKey: patch.nodeStableKey, op: patch.op, success: false, error: 'Unknown op' }
    }
    return { stableKey: patch.nodeStableKey, op: patch.op, success: true }
  } catch (err: any) {
    return { stableKey: patch.nodeStableKey, op: patch.op, success: false, error: err.message }
  }
}
