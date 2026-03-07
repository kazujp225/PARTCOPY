# PARTCOPY — Site Genome OS

**既存サイトのURLから構造を抽出・正規化し、再構成・比較・提案まで行う制作OS。**

raw HTMLを編集対象にしない。canonical block（正規化された再利用ブロック）を中心に据え、抽出→分類→正規化→比較→再構成→出力の全工程をカバーする。

---

## Architecture

```
React + Vite (Client)
  ├─ Supabase Auth (future)
  ├─ Job polling / Realtime
  └─ Canvas Editor

Express API Server (port 3001)  ← Puppeteer を持たない軽量API
  ├─ POST /api/extract          → crawl_runs に job 投入
  ├─ GET  /api/jobs/:id         → job 状態取得
  ├─ GET  /api/jobs/:id/sections → 結果取得 (signed URL付き)
  ├─ GET  /api/library          → セクション検索
  ├─ GET  /api/library/genres   → ジャンル集計
  ├─ GET  /api/library/families → ブロックファミリー一覧
  └─ GET  /api/block-variants   → バリアント一覧

Crawl Worker (別プロセス)  ← 重い処理はここ
  ├─ crawl_runs を polling → claim → process
  ├─ Puppeteer でページ取得
  ├─ DOM解析 → セクション分割
  ├─ Heuristic分類 (classifier.ts)
  ├─ セクションごと screenshot → Supabase Storage
  ├─ HTML sanitize (画像除去)
  ├─ raw/sanitized HTML → Supabase Storage
  └─ source_sections に結果書き込み

Supabase
  ├─ Postgres (4層スキーマ)
  ├─ Storage (screenshots, HTML, exports)
  ├─ pgvector (将来: 類似ブロック検索)
  └─ RLS (org/workspace境界)
```

### API / Worker 分離の理由

Puppeteerは重い。タイムアウト、メモリ圧迫、クラッシュ時の巻き添えを避けるため、APIサーバーとブラウザワーカーを完全分離。APIはジョブ投入と結果取得のみ。

---

## Database Schema (4 Layers)

### Layer 1: Tenant
```
organizations → organization_members → workspaces → projects
```
顧客境界。RLSの中心。

### Layer 2: Corpus
```
source_sites → crawl_runs → source_pages → source_sections → section_labels
```
.co.jp コーパス。研究資産。

| Table | Purpose |
|-------|---------|
| `source_sites` | ドメイン単位。genre/tags/industry付き |
| `crawl_runs` | ジョブ管理。status state machine: queued→claimed→rendering→parsed→normalizing→done/failed |
| `source_pages` | ページ単位。URL/title/screenshot_path/content_hash |
| `source_sections` | セクション単位。分類結果/特徴量/サムネ/embedding(vector) |
| `section_labels` | 分類ラベル。heuristic/human/model別。学習ループの基盤 |

### Layer 3: Canonical Block
```
block_families → block_variants → block_instances → style_token_sets
```
**ここがmoat。** raw HTMLではなく、正規化ブロックが編集対象。

| Table | Purpose |
|-------|---------|
| `block_families` | 17種: navigation, hero, feature, social_proof, stats, pricing, faq, content, cta, contact, recruit, footer, news_list, timeline, company_profile, gallery, logo_cloud |
| `block_variants` | Family内のバリエーション。例: hero_centered, hero_split_left, feature_grid_3, faq_accordion |
| `block_instances` | 実際の抽出結果をvariantにマッピング。slot_values + token_values |
| `style_token_sets` | computed styleから抽出したデザイントークン |

### Layer 4: Editor / Output
```
project_pages → project_page_blocks → project_assets → exports
```
ユーザーが編集するのはここ。

---

## Block Taxonomy (2階層)

Family = 意味、Variant = 編集可能単位。

| Family | Variants (初期) |
|--------|----------------|
| hero | hero_centered, hero_split_left, hero_split_right, hero_with_trust |
| feature | feature_grid_3, feature_grid_4, feature_grid_6, feature_alternating |
| pricing | pricing_3col, pricing_toggle |
| faq | faq_accordion, faq_2col |
| cta | cta_banner_single, cta_banner_dual |
| contact | contact_form_full, contact_split |
| footer | footer_sitemap, footer_minimal |
| navigation | nav_simple, nav_mega |
| social_proof | testimonial_cards, logo_strip |
| stats | stats_row, stats_with_text |

各variantは `slot_schema_json` を持ち、どんなスロット（headline, subheadline, primary_cta, cards, etc.）を受け入れるか定義。

---

## Classifier

`server/classifier.ts` — ヒューリスティクスベース。将来ML置き換え前提。

**判定に使う特徴量:**
- HTMLタグ (`<nav>`, `<header>`, `<footer>`, `<section>`)
- class/id名のキーワード
- テキスト内容（日本語: 「よくある質問」「お客様の声」「料金」等）
- ページ内位置 (position ratio)
- BBox (height, width)
- CTA/Form/Image/Card/Link/Headingの有無と数
- computed style (fontSize, display等)

**全特徴量が `features_jsonb` に保存され、将来のML学習データになる。**

---

## Storage Design (Supabase Storage)

| Bucket | Content |
|--------|---------|
| `corpus-raw-html` | 元HTML (provenance用) |
| `corpus-sanitized-html` | 画像除去済みHTML |
| `corpus-page-screenshots` | ページ全体スクリーンショット |
| `corpus-section-thumbnails` | セクション単位スクリーンショット |
| `project-assets` | ユーザーアップロード画像等 |
| `export-artifacts` | 出力ファイル |

すべてprivate。UIにはsigned URLで配信。base64はDBに持たない。

---

## Job State Machine

```
queued → claimed → rendering → parsed → normalizing → done
                                                    ↘ failed
```

- Worker が `queued` を atomic に `claimed` に更新して排他制御
- 各ステージでエラー → `failed` + error_code/message
- Client は polling (将来 Realtime Broadcast) でステータス監視

---

## File Structure

```
PARTCOPY/
├── server/
│   ├── index.ts          # Express API (軽量、Puppeteerなし)
│   ├── worker.ts         # Crawl Worker (Puppeteer、別プロセス)
│   ├── classifier.ts     # セクション分類 (独立モジュール)
│   └── supabase.ts       # Supabase client + bucket定義
├── supabase/
│   ├── config.toml
│   └── migrations/
│       └── 00001_initial_schema.sql  # 4層スキーマ + seed
├── src/
│   ├── App.tsx           # Job-based state + routing
│   ├── main.tsx
│   ├── styles.css
│   ├── types/index.ts    # SourceSection, CrawlJob, BlockFamily等
│   └── components/
│       ├── URLInput.tsx   # URL + genre + tags + job status
│       ├── PartsPanel.tsx # 抽出セクション (thumbnail cards)
│       ├── Canvas.tsx     # ページ構築 (drag & drop)
│       ├── Preview.tsx    # Screenshot preview
│       └── Library.tsx    # 保存済みパーツ (genre/family filter)
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── vite.config.ts
└── plan.md
```

---

## Setup

```bash
# 1. Install
npm install

# 2. Supabase local (Docker必須)
supabase start
# → 出力されるURL, anon key, service_role keyを.envに設定

# 3. 環境変数
cp .env.example .env
# → .envにSupabase credentialsを記入

# 4. 起動 (API + Worker + Client)
npm run dev:all
# → Client: http://localhost:5173
# → API:    http://localhost:3001
# → Worker: 別プロセスでcrawl_runsをpolling
```

---

## What Was Removed (and Why)

| Removed | Reason |
|---------|--------|
| `data/parts.json` | 単一ファイル保存。同時書き込み/検索/履歴/権限すべてに弱い → Supabase Postgres |
| `base64 thumbnail` | DBもAPIもUIも太る → Supabase Storage + signed URL |
| `元サイトCSS <link>注入` | CORS/変更/ブロック/依存JSで壊れる → source previewとeditor previewを分離 |
| `元CSS依存export` | 外部依存の寄せ集め → 将来自前renderer (Static/Next.js/WordPress) |
| `ExportModal` | 上記理由で廃止。P4で自前renderer実装時に再構築 |
| `server/extractor.ts` | APIとPuppeteerの同居 → API/Worker分離 |
| `server/storage.ts` | JSON CRUD → Supabase |

---

## Roadmap

### P0: Infrastructure (Current)
- [x] Supabase schema (4層, 17ファミリー, 24バリアント seed)
- [x] API/Worker分離
- [x] Job state machine
- [x] Classifier独立モジュール
- [x] Storage bucket設計
- [ ] Supabase接続 (Docker起動後)
- [ ] Realtime Broadcast (job進捗)

### P1: Classification Quality
- [ ] features_jsonbを教師データの起点に
- [ ] Internal labeling UI
- [ ] Eval run + precision tracking
- [ ] Model version管理

### P2: Canonical Block Normalization
- [ ] source_section → block_instance 変換
- [ ] Style token extractor (computed style → tokens)
- [ ] pgvector で類似ブロック検索
- [ ] Quality score

### P3: Editor
- [ ] Block recipe ベースcanvas
- [ ] Slot editing (headline, CTA text等)
- [ ] Token editing (色、余白、フォント)
- [ ] Source preview / Editor previewの二面化
- [ ] Autosave + 履歴

### P4: Export / Publish
- [ ] Static HTML/CSS renderer
- [ ] Next.js + Tailwind renderer
- [ ] WordPress export
- [ ] SEO / OGP / sitemap
- [ ] フォーム連携

### P5: Benchmark / Proposal
- [ ] 業種別cohort構造比較
- [ ] 競合比較 (欠落ブロック、CTA配置)
- [ ] 提案書PDF出力
- [ ] "URL→初稿" を5分以内に

### P6: AI Layer
- [ ] Copy rewrite (slot単位)
- [ ] Block recommendation (業種×目的)
- [ ] Site map draft generation
- [ ] Similar site recommendation (pgvector)

---

## North Star Metric

> **既存企業サイトの再構築にかかる構造設計時間を、何分の1にできたか**

KPI: URL→初稿時間 / 人手修正時間 / 提案採択率 / 1社あたり月間処理案件数
