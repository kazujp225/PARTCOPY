# PARTCOPY アーキテクチャ全体図

## 現状の問題点（2026-03-07時点）

**UIに表示されるセクションプレビューは、実質的に「画像と同じ」状態。**

理由：
- `SectionFrame.tsx` は `/api/sections/:id/render` から完成済みHTMLを取得し、`<iframe srcdoc>` に丸ごと流し込んでいる
- iframe は `sandbox="allow-same-origin"` + `pointerEvents: 'none'` で**操作不能**
- ユーザーはセクション内のテキスト・画像・ボタンを**選択も編集もできない**
- 結果として、スクリーンショットを貼っているのと機能的に同じ

**本来の目的：**
> 取得したHTMLコードを分解し、各要素（テキスト・画像・ボタン等）を個別に編集可能にする

---

## 現在のシステム構成

```
ブラウザ (React SPA)          API Server (Express:3001)         Worker (Puppeteer)
========================     ==========================        ===================
URLInput                      POST /api/extract                 pollLoop()
  ↓ URL入力                     → source_sites upsert             ↓ 3秒間隔ポーリング
  ↓                             → crawl_runs insert               ↓
App.tsx pollJob(jobId)        GET /api/jobs/:id                  claimJob()
  ↓ 2秒間隔ポーリング            → crawl_runs select               ↓
  ↓                                                             processJob(job)
PartsPanel                   GET /api/jobs/:id/sections            ↓ 6フェーズ
  ↓ SectionFrame               → source_sections select          (詳細は下記)
  ↓                             → htmlUrl生成
Canvas                       GET /api/sections/:id/render
  ↓ SectionFrame               → raw HTML + CSS bundle取得
  ↓                             → relative URL → absolute変換
Preview                        → inline <style> で結合
  ↓ SectionFrame               → text/html レスポンス
Library
  ↓ SectionFrame             GET /api/library
                               → source_sections 一覧
                             GET /api/library/genres
                             GET /api/library/families
                             GET /api/block-variants
                             DELETE /api/library/:id
```

---

## データフロー詳細

### Phase 1: ページキャプチャ (`capture-runner.ts`)

```
入力: URL (例: https://asue.jp)
  ↓
puppeteer.launch({ headless: true })
  ↓
page.setViewport({ width: 1440, height: 900 })
page.setUserAgent('Chrome/120')
  ↓
page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
  ↓
スクロールによるlazy-load発火（200ms間隔で全ページスクロール）
  ↓
page.content() → finalHtml (JS実行後の完全DOM)
page.title() → title
page.screenshot({ fullPage: true }) → fullScreenshot (QA用PNG)
  ↓
出力: CaptureResult { finalUrl, title, lang, finalHtml, fullScreenshot, viewport }
```

**問題:** `page.content()` で取得するのは**ページ全体**のHTML文字列。セクション単位ではない。

### Phase 2: CSS・アセット収集 (`network-recorder.ts`)

```
入力: 読み込み済みのPuppeteerページ
  ↓
collectPageCSS(page):
  ├── document.styleSheets → cssRules を直接読み取り（同一オリジン）
  ├── fetch() で cross-origin stylesheet を取得
  └── <style> タグのinline CSSを収集
  → 全CSS結合文字列（数百KB〜1.5MB）
  ↓
fixCSSUrls(css, pageOrigin):
  → url() 内の相対パスを絶対URLに変換
  ↓
collectAssetRecords(page):
  → link[rel=stylesheet], img, link[as=font], script[src] のURL一覧
  ↓
出力: cssBundle (string), assetList (AssetRecord[])
```

### Phase 3: ページレベルデータ保存 (`worker.ts`)

```
Supabase Storageにアップロード:
  ├── corpus-raw-html/{siteId}/{jobId}/final.html    (最終DOM)
  ├── corpus-page-screenshots/{siteId}/{jobId}/fullpage.png (QA用)
  ├── corpus-raw-html/{siteId}/{jobId}/styles.css    (CSS bundle)
  └── corpus-raw-html/{siteId}/{jobId}/assets.json   (アセット一覧)

DBに保存:
  ├── source_pages レコード作成
  │     url, title, screenshot_storage_path,
  │     final_html_path, css_bundle_path, request_log_path
  └── page_assets レコード作成（stylesheet/font/image/script × 最大200件）
```

### Phase 4: セクション検出 (`section-detector.ts`)

```
入力: 読み込み済みのPuppeteerページ（ブラウザ内 page.evaluate で実行）

Step 1: セマンティック候補収集
  document.querySelectorAll('header, nav, main, section, article, aside, footer')
  → rect.height >= 40 && rect.width >= 200 のもの

Step 2: 再帰的アンラッパー（tryAdd）
  要素の高さ > viewport × 1.5 の場合:
    ├── nav/header/footer → そのまま保持
    ├── 子要素が2個以上 && 深度 < 4 → 子要素に再帰
    └── それ以外 → そのまま保持

Step 3: ソース走査
  ├── セマンティック要素（他に含まれないもの）を処理
  ├── body 直下の子要素（未処理のもの）を処理
  └── <main> の子要素（未処理のもの）を処理

Step 4: 重複排除 & Y座標順ソート

Step 5: 各要素から特徴量抽出
  ├── tagName, outerHTML, textContent, domPath
  ├── boundingBox { x, y, width, height }
  ├── computedStyles { backgroundColor, fontSize, fontFamily, ... }
  ├── features { headingCount, linkCount, buttonCount, formCount,
  │              imageCount, imageSources, cardCount, childCount,
  │              listItemCount, hasVideo, hasSvg, textLength,
  │              positionRatio, repeatedChildPattern }
  ├── classTokens（自身 + 最初の20子要素のclass）
  └── idTokens

出力: DetectedSection[] (例: asue.jpで19セクション)
```

**重要:** `outerHTML` は**元素のHTML文字列**。これが「コード」の実体。
しかし現在、これは「表示」にしか使われず、**編集UIは存在しない**。

### Phase 5: 分類 + 正規化 + 保存

#### 5a: 分類 (`classifier.ts`)

```
入力: RawSection (tagName, classNames, textContent, position, features)

ヒューリスティックルール（上から順にマッチ）:
  tag=nav OR class含む"nav"       → navigation (0.95)
  tag=footer OR class含む"footer" → footer (0.95)
  pos<0.25 AND class含むhero系    → hero (0.95)
  pos<0.2 AND height>300 AND CTA  → hero (0.80)
  class含む"faq"                  → faq (0.90)
  class含む"pricing"              → pricing (0.75-0.90)
  hasForm OR class含む"contact"   → contact (0.85)
  class含む"testimonial"/"voice"  → social_proof (0.85)
  class含む"feature"/"service"    → feature (0.70-0.85)
  cardCount >= 3                  → feature (0.60)
  それ以外                        → content (0.30-0.50)

出力: { type: BlockFamily, confidence: number }
```

#### 5b: 正規化 (`canonicalizer.ts`)

```
入力: DetectedSection + classifiedFamily

family別のスロット抽出:
  hero    → { headline, subheadline, primaryCta, secondaryCta, hasMedia }
  feature → { sectionTitle, itemCount, hasIcons, repeatedPattern }
  cta     → { headline, primaryCta, secondaryCta, buttonCount }
  faq     → { sectionTitle, itemCount, hasAccordion }
  contact → { headline, hasForm, hasMap, hasPhone, hasEmail }
  footer  → { linkCount, hasSocialLinks, hasCopyright, columnCount }
  pricing → { sectionTitle, planCount }
  ...

family別のバリアント判定:
  hero    → hero_centered / hero_split_left / hero_with_trust
  feature → feature_grid_3 / feature_grid_4 / feature_grid_6 / feature_alternating
  cta     → cta_banner_single / cta_banner_dual
  faq     → faq_accordion / faq_2col
  ...

トークン抽出（全family共通）:
  alignment  → left / center / right
  bgTone     → light / dark / medium / transparent
  headingScale → sm / md / lg / xl / 2xl
  spacingY   → sm / md / lg / xl

qualityScore = スロット充填率（0.0〜1.0）

出力: CanonicalBlock { family, variant, slots, tokens, qualityScore }
```

#### 5c: 保存

```
各セクションについて:
  ├── standalone HTML生成 (buildStandaloneHTML)
  │     → section.outerHTML + <link> to CSS bundle URL
  │     → relative URL → absolute URL 変換
  │     → corpus-sanitized-html に保存
  │
  ├── raw HTML保存
  │     → section.outerHTML そのまま
  │     → corpus-raw-html に保存
  │
  ├── QAスクリーンショット（非必須）
  │     → page.screenshot({ clip: bbox })
  │     → corpus-section-thumbnails に保存
  │
  ├── source_sections レコード
  │     page_id, site_id, order_index, dom_path, tag_name,
  │     bbox_json, raw_html_storage_path, sanitized_html_storage_path,
  │     thumbnail_storage_path, block_family, block_variant,
  │     classifier_confidence, features_jsonb, text_summary,
  │     layout_signature, image_count, button_count,
  │     repeated_child_pattern, class_tokens, id_tokens,
  │     computed_style_summary
  │
  └── block_instances レコード（canonicalize成功時）
        source_section_id, block_variant_id,
        slot_values_jsonb, token_values_jsonb,
        quality_score, family_key, variant_key,
        provenance_jsonb
```

### Phase 6: 完了

```
crawl_runs.status → 'done'
crawl_runs.section_count → 検出数
source_sites.status → 'analyzed'
source_sites.last_crawled_at → now()
```

---

## UI表示フロー

### SectionFrame.tsx（全画面共通のプレビューコンポーネント）

```
入力: htmlUrl = "/api/sections/{sectionId}/render"
  ↓
fetch(htmlUrl) → HTML文字列取得
  ↓
<iframe srcdoc={html}
  sandbox="allow-same-origin"
  pointerEvents="none"
  loading="lazy" />
  ↓
iframe.contentDocument.body.scrollHeight → 高さ自動調整
scale prop で縮小表示（PartsPanel: 0.45, Library: 0.5）
```

### /api/sections/:sectionId/render エンドポイント

```
1. source_sections から raw_html_storage_path, page_id 取得
2. source_pages から css_bundle_path, url 取得
3. CSS bundle ダウンロード（10分キャッシュ）
4. raw section HTML ダウンロード
5. relative URL → absolute URL 変換（src, href, srcset, poster, action）
6. 結合:
   <!DOCTYPE html>
   <html lang="ja">
   <head>
     <base href="{pageOrigin}/">
     <style>{全CSS}</style>
   </head>
   <body style="margin:0;padding:0">{section outerHTML}</body>
   </html>
7. Content-Type: text/html, Cache-Control: 1h
```

### 各画面での使用

| 画面 | コンポーネント | scale | maxHeight | 用途 |
|------|-------------|-------|-----------|------|
| Editor左パネル | PartsPanel | 0.45 | 300 | セクション一覧 |
| Editor中央 | Canvas | 1.0 | 600 | 配置済みブロック |
| Preview | Preview | 1.0 | 2000 | プレビュー |
| Library | Library | 0.5 | 260 | 全セクション検索 |

---

## DB スキーマ概要

### Layer 1: テナント（未使用）
- `organizations` / `organization_members` / `workspaces` / `projects`

### Layer 2: コーパス（メインで使用）
- `source_sites` — ドメイン単位。genre, tags, status
- `crawl_runs` — クロールジョブ。status state machine
- `source_pages` — ページ単位。url, title, css_bundle_path, final_html_path
- `source_sections` — セクション単位。outerHTML保存パス、分類、特徴量
- `page_assets` — CSS/font/image/scriptのURL記録
- `section_labels` — ラベリング（未使用）

### Layer 3: 正規ブロック
- `block_families` — 17種（navigation, hero, feature, ...）
- `block_variants` — 24種（hero_centered, feature_grid_3, ...）
- `block_instances` — セクション→バリアントの紐付け + slots + tokens
- `style_token_sets` — スタイルトークン（未使用）

### Layer 4: エディタ/出力（未使用）
- `project_pages` / `project_page_blocks` / `project_assets` / `exports`

---

## Supabase Storage バケット

| バケット | 内容 | 例 |
|---------|------|-----|
| corpus-raw-html | 最終DOM, CSS bundle, アセットJSON, セクションraw HTML | `{siteId}/{jobId}/final.html` |
| corpus-sanitized-html | standalone HTML（CSS bundle URL参照） | `{siteId}/{jobId}/standalone_0.html` |
| corpus-page-screenshots | ページ全体スクリーンショット（QA用） | `{siteId}/{jobId}/fullpage.png` |
| corpus-section-thumbnails | セクション単位スクリーンショット（QA用） | `{siteId}/{jobId}/section_0.png` |
| project-assets | プロジェクト素材（未使用） | - |
| export-artifacts | エクスポート成果物（未使用） | - |

---

## 新設レイヤー（v3 Editable Layer）

### Mutation Model

```
source_sections (immutable archive)
  ↓ Phase 5.5
section_dom_snapshots (resolved HTML + data-pc-key)
  ↓
section_nodes (編集可能ノードのフラットツリー)
  ↓ ユーザー操作
section_patch_sets (編集セッション)
  → section_patches (set_text, set_attr, replace_asset, ...)
  ↓
project_page_blocks (render_mode: source_patch | canonical)
  ↓
表示: EditableSourceFrame (postMessage 経由でパッチ適用)
編集: NodeInspector (テキスト/リンク/画像/削除)
```

### UI コンポーネント 3分割

| コンポーネント | 用途 | pointerEvents | sandbox |
|---|---|---|---|
| SourcePreviewFrame | QA・Library・分類確認 | none | allow-same-origin |
| EditableSourceFrame | Canvas編集モード | 有効 | allow-same-origin allow-scripts |
| BlockRendererFrame | Canonical Mode (未実装) | 有効 | - |

### パッチ操作（op）

| op | payload | 説明 |
|---|---|---|
| set_text | { text } | テキスト変更 |
| set_attr | { attr, value } | 属性変更 |
| replace_asset | { src, alt? } | 画像差し替え |
| remove_node | {} | 要素削除 |
| insert_after | { html } | 要素追加 |
| move_node | { targetKey, position } | 要素移動 |
| set_style_token | { property, value } | スタイル変更 |
| set_class | { add?, remove? } | クラス操作 |

### 新API

| Method | Path | 説明 |
|---|---|---|
| GET | /api/sections/:id/dom | ノード一覧取得 |
| GET | /api/sections/:id/editable-render | 編集用HTML（data-pc-key付き） |
| POST | /api/sections/:id/patch-sets | パッチセット作成 |
| POST | /api/patch-sets/:id/patches | パッチ追加 |
| GET | /api/patch-sets/:id | パッチセット+パッチ取得 |
| POST | /api/projects/:id/page-blocks | ページブロック作成 |

---

## 旧: 致命的ギャップ（修正中）

### 1. 表示が「画像」と同等
- iframe + srcdoc + pointerEvents:none = 見るだけ
- テキスト選択、編集、要素操作が一切不可能
- スクリーンショットを貼り付けているのと実質同じ

### 2. コードは取得しているが活用していない
- `section.outerHTML` → Storage保存 → render APIでそのまま返す → iframeに丸投げ
- HTMLの構造解析（DOM tree操作）をフロントエンドで行っていない
- canonical block の slots/tokens は DB に保存されるが、UIに表示されない

### 3. 編集レイヤーが未実装
- Layer 4（project_pages, project_page_blocks）は完全未使用
- slot_overrides / token_overrides による編集フローが未構築
- Canvas上のブロックは「参照」のみ。コピー→編集→保存の機能なし

### 4. エクスポートが未実装
- exports テーブルは存在するがロジックなし
- static_html / nextjs_tailwind / wordpress / json_schema のいずれも未構築

---

## 本来あるべきフロー（未実装）

```
現在:
  URL → Worker → outerHTML保存 → render API → iframe表示（見るだけ）

本来:
  URL → Worker → outerHTML保存
                    ↓
               canonical block化（slots/tokens抽出）← ここまでは実装済み
                    ↓
               エディタUI（slots編集パネル）← 未実装
                 ├── headline テキスト編集
                 ├── CTA ボタンテキスト・URL編集
                 ├── 画像差し替え
                 ├── tokens変更（色、フォント、余白）
                 └── リアルタイムプレビュー
                    ↓
               project_page_blocks として保存 ← 未実装
                    ↓
               エクスポート（HTML/Next.js/WordPress） ← 未実装
```

---

## ファイル構成

```
PARTCOPY/
├── server/
│   ├── index.ts              API サーバー (Express:3001)
│   ├── worker.ts             ワーカー（6フェーズパイプライン）
│   ├── supabase.ts           Supabase クライアント初期化
│   ├── capture-runner.ts     Puppeteer ページキャプチャ
│   ├── network-recorder.ts   CSS・アセット収集
│   ├── section-detector.ts   セクション検出（再帰的アンラッパー）
│   ├── classifier.ts         ヒューリスティック分類器
│   ├── canonicalizer.ts      正規化（slots/tokens抽出）
│   └── style-extractor.ts    スタイル要約・レイアウト署名・standalone HTML
├── src/
│   ├── App.tsx               メインアプリ（Editor/Library/Preview切替）
│   ├── types/index.ts        TypeScript型定義
│   ├── styles.css            全体CSS（白ベース）
│   └── components/
│       ├── URLInput.tsx       URL入力フォーム
│       ├── SectionFrame.tsx   iframe プレビュー（全画面共通）
│       ├── PartsPanel.tsx     左パネル：セクション一覧
│       ├── Canvas.tsx         中央：ブロック配置（ドラッグ&ドロップ）
│       ├── Preview.tsx        プレビュー画面
│       └── Library.tsx        ライブラリ画面（フィルタ付き）
├── supabase/migrations/
│   ├── 00001_initial_schema.sql   初期スキーマ（4層）
│   └── 00002_v2_source_archive.sql  v2拡張（page_assets等）
├── .env                      環境変数（SUPABASE_URL, KEY等）
├── vite.config.ts            Vite設定（/api → localhost:3001 プロキシ）
├── package.json
└── tsconfig.json
```
