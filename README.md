# PARTCOPY — Site Genome OS

## What is PARTCOPY?

**PARTCOPY は、既存の Web サイトを「パーツ」に分解し、自由に再構成できるツールです。**

URL を入力するだけで、サイトの HTML/CSS/画像/フォントを丸ごとダウンロードし、ヘッダー・ヒーロー・料金表・FAQ・フッターといったセクション単位に自動分割。分割されたパーツはライブラリに蓄積され、ドラッグ&ドロップで新しいページを組み立てられます。

### 誰のためのツール？

- **Web 制作会社** — 競合サイトの構造を分析し、提案の初稿を最速で作りたい
- **LP デザイナー** — 業種ごとの「勝ちパターン」をパーツ単位で比較・収集したい
- **マーケター** — 他社サイトの CTA 配置やセクション構成を定量的に把握したい

### 何ができる？

| 機能 | 説明 |
|------|------|
| **URL → パーツ分解** | URL を入力するとサイトを完全ダウンロードし、セマンティックなセクション（Hero, Feature, Pricing, FAQ 等 17 種）に自動分類 |
| **パーツライブラリ** | 抽出したパーツをジャンル・ブロックタイプ・特徴量で横断検索。複数サイトのパーツを一元管理 |
| **Canvas エディタ** | ライブラリからパーツを選んでドラッグ&ドロップでページ構成。順序変更・削除も自由 |
| **ビジュアル編集** | パーツ内のテキスト・画像・リンクをクリックして直接編集。変更はリアルタイムプレビュー |
| **HTML コード編集** | パーツの HTML を直接書き換え。ライブプレビュー付きコードエディタ |
| **ライブプレビュー** | Canvas に配置したパーツを実際のページとして縦積みプレビュー |

### 処理の流れ

```
URL 入力  →  サイト完全ダウンロード  →  セクション自動検出  →  分類・正規化
                                                                    ↓
              ライブプレビュー  ←  Canvas で再構成  ←  パーツライブラリに蓄積
```

---

## Quick Start

```bash
# インストール
npm install

# 起動（Docker 不要 / ローカルモード）
npm run dev
# → Client: http://127.0.0.1:5180
# → API:    http://localhost:3002
# → Worker: crawl_runs をポーリング
# → データ保存先: .partcopy/
```

ブラウザで http://127.0.0.1:5180 を開き、URL を入力して「Extract」を押すだけ。

### Supabase を使う場合（オプション）

```bash
cp .env.example .env
# SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY を設定
# キーがあれば Supabase モード、なければ自動でローカルモード
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  React + Vite (Client)            http://127.0.0.1:5180          │
│  URLInput → PartsPanel → Canvas → Preview → Library              │
└──────────────── /api/* proxy ─────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────────┐
│  Express API Server               http://localhost:3002           │
│  ジョブ投入・結果取得・セクション配信（軽量、Puppeteer なし）         │
└──────────────────────── polling ──────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────────┐
│  Crawl Worker (別プロセス)                                        │
│  site-downloader → section-detector → classifier → canonicalizer │
│  → dom-parser → style-extractor                                  │
└──────────────────────── storage ─────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────────┐
│  Storage (自動切り替え)                                            │
│  Supabase (Postgres + Storage) / Local (.partcopy/)               │
└──────────────────────────────────────────────────────────────────┘
```

### API / Worker 分離の理由

Puppeteer は重い。タイムアウト・メモリ圧迫・クラッシュ時の巻き添えを避けるため、API サーバーとブラウザワーカーを完全分離。API はジョブ投入と結果取得のみ。

---

## Worker パイプライン

Worker は 5 フェーズでサイトを処理する。

### Phase 1: Complete Site Download

Puppeteer でページを開き、HTML/CSS/画像/フォントを全てダウンロード。URL を長さ降順でソートし、相対パス・srcset も含めて全てローカルパスに書き換え。

### Phase 2: Page-Level Storage

書き換え済み HTML、CSS バンドル、フルページスクリーンショット、アセット一覧を保存。

### Phase 3: Section Detection

ブラウザ内で `<header>`, `<nav>`, `<section>`, `<footer>` 等のセマンティック要素を収集。大きすぎる要素は子に分解、重複は排除し、各セクションの特徴量（heading 数、画像数、CTA 有無等）を抽出。

### Phase 4: Classification + Canonicalization

17 種の Block Family（navigation, hero, feature, pricing, faq, cta, contact, footer 等）にルールベースで分類。さらにバリアント（hero_centered, feature_grid_3 等 24 種）を判定し、スロット（コンテンツ）とトークン（デザイン）に正規化。

### Phase 5: DOM Snapshot + Storage

各セクションの編集可能な DOM ツリーを生成（`data-pc-key` 属性付き）。テキスト・画像・リンク等を個別に編集できる粒度でノードを保存。

---

## 17 Block Families

| Family | 説明 | 例 |
|--------|------|-----|
| navigation | グローバルナビ | ヘッダー、メガメニュー |
| hero | ファーストビュー | キャッチコピー + CTA |
| feature | 特徴・サービス紹介 | 3カラムカード、交互レイアウト |
| social_proof | お客様の声 | テスティモニアル、レビュー |
| stats | 実績・数字 | カウンター、数値ハイライト |
| pricing | 料金プラン | 3カラム比較表 |
| faq | よくある質問 | アコーディオン、2カラム |
| content | 汎用コンテンツ | テキスト + 画像 |
| cta | コンバージョン誘導 | バナー、ボタン |
| contact | お問い合わせ | フォーム、連絡先情報 |
| recruit | 採用情報 | 求人、スタッフ紹介 |
| footer | フッター | サイトマップ、コピーライト |
| news_list | お知らせ | ブログ一覧、ニュース |
| timeline | 沿革・ステップ | タイムライン表示 |
| company_profile | 会社概要 | 企業情報テーブル |
| gallery | ギャラリー | 写真グリッド |
| logo_cloud | ロゴ一覧 | パートナー、導入企業 |

---

## 編集機能

### ビジュアル編集（EditableSourceFrame + NodeInspector）

Canvas 上のパーツで「編集」をクリックすると、iframe 内の要素をクリックで選択可能に。選択したノードのテキスト・リンク・画像をインスペクタから直接編集。変更は `postMessage` 経由でリアルタイム反映。

### HTML コード編集（CodeEditor）

`</>` ボタンでコードエディタを開き、パーツの HTML を直接編集。右側にライブプレビュー。Cmd+S で保存。

### パッチ操作

| op | payload | 説明 |
|----|---------|------|
| `set_text` | `{ text }` | テキスト変更 |
| `set_attr` | `{ attr, value }` | 属性変更 |
| `replace_asset` | `{ src, alt? }` | 画像差し替え |
| `remove_node` | `{}` | 要素削除 |
| `set_style_token` | `{ property, value }` | CSS 変更 |
| `set_class` | `{ add?, remove? }` | クラス操作 |

---

## npm scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Client + Server + Worker 同時起動 |
| `npm run dev:client` | Vite dev server (port 5180) |
| `npm run dev:server` | API server (port 3002) |
| `npm run dev:worker` | Worker (polling 3秒) |
| `npm run build` | TypeScript + Vite ビルド |
| `npm run test` | テスト実行 |

---

## 環境変数

```
PARTCOPY_API_PORT=3002                          # API サーバーポート
PARTCOPY_CLIENT_PORT=5180                       # Client ポート
SUPABASE_URL=http://127.0.0.1:54321             # Supabase URL（オプション）
SUPABASE_ANON_KEY=your-anon-key                 # 公開キー（オプション）
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key  # サーバーキー（オプション）
```

`SUPABASE_SERVICE_ROLE_KEY` が未設定なら自動でローカルモード（`.partcopy/` にデータ保存）。

---

## File Structure

```
PARTCOPY/
├── server/
│   ├── index.ts              # Express API（軽量、Puppeteer なし）
│   ├── worker.ts             # Crawl Worker（5 フェーズパイプライン）
│   ├── site-downloader.ts    # サイト完全ダウンロード + URL 書き換え
│   ├── section-detector.ts   # セマンティックセクション検出
│   ├── classifier.ts         # ヒューリスティック分類（17 families）
│   ├── canonicalizer.ts      # スロット/トークン正規化
│   ├── dom-parser.ts         # 編集可能 DOM スナップショット
│   ├── style-extractor.ts    # スタイル要約 + レイアウトシグネチャ
│   ├── network-recorder.ts   # CSS 収集 + URL 解決
│   ├── local-store.ts        # ローカル JSON DB（Supabase 代替）
│   └── supabase.ts           # Supabase client 初期化
├── src/
│   ├── App.tsx               # メイン状態管理
│   ├── main.tsx              # React エントリポイント
│   ├── styles.css            # UI スタイル
│   └── components/
│       ├── URLInput.tsx          # URL + genre + tags 入力
│       ├── PartsPanel.tsx        # 抽出パーツ一覧
│       ├── Canvas.tsx            # 編集キャンバス（DnD + 編集モード）
│       ├── EditableSourceFrame.tsx # 編集可能 iframe
│       ├── SourcePreviewFrame.tsx  # 読み取り専用プレビュー
│       ├── NodeInspector.tsx     # ノード編集パネル
│       ├── CodeEditor.tsx        # HTML コードエディタ
│       ├── Preview.tsx           # ライブプレビュー
│       └── Library.tsx           # パーツライブラリ検索
├── .partcopy/                    # ローカルモードデータ（gitignore）
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Roadmap

### Done
- URL → サイト完全ダウンロード → セクション検出 → 分類 → 正規化
- パーツライブラリ（ジャンル/ファミリーフィルタ + 検索）
- Canvas エディタ（DnD + ビジュアル編集 + コード編集）
- DOM スナップショット + パッチエンジン
- Dual-mode storage（Supabase / Local）

### Next
- 分類精度向上（教師データ + ML モデル）
- pgvector で類似パーツ検索
- Static HTML / Next.js + Tailwind エクスポート
- 業種別構造比較・競合分析レポート
- AI によるコピーライティング提案

---

## North Star

> **既存サイトの再構築にかかる構造設計時間を、何分の 1 にできたか**
