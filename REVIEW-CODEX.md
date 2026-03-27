# PARTCOPY レビュー: マルチサイト合成が壊れる原因と修正方針

## ゴール
複数サイトからパーツを取得 → Canvas で組み合わせ → TSX 出力 → 統一サイトとして動作

## 現状: 壊れている

---

## CRITICAL: 修正必須 (3件)

### 1. CSS スコープが無い — 全セクションのCSSがグローバル衝突

**場所**: `server/index.ts:1616` (TSX生成), `server/index.ts:849-913` (render)

**問題**: 各セクションの元サイト全CSSを `<style dangerouslySetInnerHTML>` でそのまま埋め込み。
onecareer.jp の `.button { color: blue }` と mynavi.jp の `.button { color: green }` が衝突し、後勝ちになる。
`body`, `*`, `.container` 等のグローバルセレクタが全ページに影響。

**再現**: Canvas に 2サイト以上のセクションを入れて ZIP 出力 → フォント・色・レイアウトが壊れる

**修正方針**:
- 各セクションの CSS を一意のクラスプレフィックスでスコープする
  - 例: `.pc-section-{id} .button { ... }` のように全セレクタをラップ
- または Shadow DOM / iframe isolation を使う
- `body`, `html`, `*` 等のグローバルセレクタは除去またはスコープ変換
- `@font-face` 宣言は重複排除して1箇所に集約

```tsx
// Before (壊れる)
<style dangerouslySetInnerHTML={{ __html: `.button { color: blue }` }} />
<div dangerouslySetInnerHTML={{ __html: html }} />

// After (スコープ付き)
<style dangerouslySetInnerHTML={{ __html: `.pc-sec-abc123 .button { color: blue }` }} />
<div className="pc-sec-abc123" dangerouslySetInnerHTML={{ __html: html }} />
```

---

### 2. 画像が30日で全部404になる — Signed URL 有効期限

**場所**: `server/site-downloader.ts:41` (`SIGNED_URL_EXPIRY = 30日`)

**問題**: 全画像・フォント・背景画像が Supabase signed URL で参照されている。
ZIP エクスポートにもこの URL がハードコード。30日後に全画像が消える。

**再現**: 1ヶ月前にエクスポートした ZIP を `npm run dev` → 画像全て404

**修正方針**:
- ZIP エクスポート時に実際の画像ファイルを `/public/assets/` にダウンロード同梱
- HTML/CSS 内の signed URL を相対パス (`/assets/img-xxx.png`) に書き換え
- preview 用は signed URL のまま可（短期利用のため）

```
exported-project/
  public/
    assets/
      hero-bg.jpg      ← 実ファイル
      logo.png          ← 実ファイル
  src/
    components/
      HeroSection.tsx   ← <img src="/assets/hero-bg.jpg" />
```

---

### 3. プレビューが最終形と一致しない — 統合プレビュー未実装

**場所**: `src/components/Preview.tsx`

**問題**: プレビューは各セクションを個別の iframe で表示。
CSS が隔離されるため衝突が見えず、ユーザーは問題に気づけない。
エクスポートして初めて壊れていると分かる。

**修正方針**:
- 「統合プレビュー」モードを追加: 全セクションを1つの iframe 内で結合表示
- CSS スコープ修正 (#1) と組み合わせて、最終出力と同じ表示にする
- `/api/preview/merged?sections=id1,id2,id3` エンドポイント新設

---

## HIGH: 強く推奨 (3件)

### 4. ZIP にアセットファイルが含まれない

**場所**: `server/index.ts:1605-1750` (ZIP生成)

**問題**: ZIP は TSX ソースのみ。画像・フォントの実体ファイルが無い。
signed URL 頼みなので、オフライン環境や URL 期限切れで完全に使えなくなる。

**修正**: ZIP 生成時に各セクションの画像を fetch → `/public/assets/` に格納 → URL 書き換え

---

### 5. Tailwind Config が合わない

**場所**: `server/index.ts:1712-1743` (index.css 生成)

**問題**: エクスポートされる app の Tailwind config と、元サイトの Tailwind config が異なる。
`.bg-red-500` が元サイトでは `#ef4444` だが app では違う値になる可能性。

**修正**:
- エクスポート時は Tailwind utility を使わず、インライン化された CSS のみ使用
- または各セクションの CSS から Tailwind utility を実値に解決してから出力

---

### 6. @font-face 宣言の重複

**問題**: 3サイトから取ったセクションが全て Noto Sans JP を使う場合、
@font-face が3回宣言される（各セクションの CSS bundle に含まれるため）。

**修正**: CSS スコープ処理 (#1) の中で @font-face を抽出・重複排除し、グローバルに1回だけ宣言

---

## MEDIUM: 改善推奨 (2件)

### 7. TSX が dangerouslySetInnerHTML 依存

**問題**: 生成される TSX は実質 HTML 文字列の埋め込み。React コンポーネントとして編集不可。
`dangerouslySetInnerHTML` は XSS リスクもある。

**将来的修正**: HTML → JSX 変換（属性名変換、イベントハンドラ変換）を行い、
真の React コンポーネントとして出力

---

### 8. カスタムセクション追加の導線が無い

**問題**: フォームや自作 HTML を追加する API は作ったが、
UI 上に「カスタム HTML を追加」ボタンが無い。

**修正**: Canvas ヘッダーに「+ カスタムブロック」ボタン追加。
テキストエリアで HTML を入力 → API 経由でセクション化

---

## 修正の優先順位

```
Phase 1 (これが無いと使えない):
  #1 CSS スコープ — 全セレクタをセクション ID でラップ
  #2 画像の実体同梱 — ZIP に /public/assets/ を含める
  #3 統合プレビュー — 結合後の表示を確認可能に

Phase 2 (品質向上):
  #4 アセット同梱
  #5 Tailwind 整合
  #6 @font-face 重複排除

Phase 3 (将来):
  #7 真の JSX 変換
  #8 カスタムブロック UI
```

---

## 実装のヒント

### CSS スコープの実装案 (postcss)

```typescript
import postcss from 'postcss'

function scopeCss(css: string, scopeClass: string): string {
  const root = postcss.parse(css)
  root.walkRules(rule => {
    // body, html, * はスコープクラス自体に変換
    rule.selectors = rule.selectors.map(sel => {
      if (/^(body|html|\*)/.test(sel)) {
        return sel.replace(/^(body|html|\*)/, `.${scopeClass}`)
      }
      return `.${scopeClass} ${sel}`
    })
  })
  return root.toString()
}
```

### 画像同梱の実装案

```typescript
// ZIP 生成時
for (const section of sections) {
  const images = extractImageUrls(section.html)
  for (const url of images) {
    const buffer = await fetch(url).then(r => r.arrayBuffer())
    const filename = `img-${hash(url)}.${ext(url)}`
    zip.file(`public/assets/${filename}`, buffer)
    section.html = section.html.replace(url, `/assets/${filename}`)
  }
}
```
