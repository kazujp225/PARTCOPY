# PARTCOPY — Site Genome OS

## What is PARTCOPY?

**PARTCOPY は、既存の Web サイトを「パーツ」に分解し、React TSX に自動変換して再利用できるツールです。**

URL を入力するだけで、サイトの HTML/CSS/画像/フォントを丸ごとダウンロードし、ヘッダー・ヒーロー・料金表・FAQ・フッターといったセクション単位に自動分割。分割されたパーツは **Claude が自動で React TSX コンポーネントに変換**。変換されたコードは ZIP でダウンロードし、そのまま実務で使えます。

### 何ができる？

| 機能 | 説明 |
|------|------|
| **URL → パーツ分解** | URL を入力するとサイトを完全ダウンロード（CSS/画像/フォント含む）し、セクション単位に自動分割 |
| **自動 TSX 変換** | 抽出した各パーツを Claude が自動で React TSX コンポーネントに変換（デザイン完全保持） |
| **Canvas エディタ** | パーツを選んでドラッグ&ドロップでページ構成。順序変更・削除も自由 |
| **ZIP エクスポート** | Canvas のパーツを React プロジェクトとして ZIP ダウンロード。`npm install && npm run dev` ですぐ動く |
| **自動クロール** | URL リストを登録して放置。自動でサイトを巡回しパーツを蓄積 |
| **フェーズ可視化** | DL → 検出 → 分類 → TSX変換 の進行状況をリアルタイム表示 |

### 処理の流れ

```
URL 入力  →  サイト完全ダウンロード  →  セクション自動検出  →  分類
                                                                 ↓
ZIP DL  ←  Canvas で再構成  ←  パーツライブラリ  ←  Claude TSX 変換
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

### 前提条件

- **Node.js** 18+
- **Claude Code** インストール・ログイン済み（TSX 変換に使用）

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
│  URLInput → PartsPanel → Canvas → Preview → ZIP Export           │
└──────────────── /api/* proxy ─────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────────┐
│  Express API Server               http://localhost:3002           │
│  ジョブ投入・結果取得・TSX取得・ZIP生成                              │
└──────────────────────── polling ──────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────────┐
│  Crawl Worker (別プロセス)                                        │
│  site-downloader → section-detector → classifier → canonicalizer │
│  → dom-parser → style-extractor → claude TSX 変換                │
└──────────────────────── storage ─────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────────┐
│  Storage (自動切り替え)                                            │
│  Supabase (Postgres + Storage) / Local (.partcopy/)               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Worker パイプライン

Worker は 6 フェーズでサイトを処理する。

### Phase 1: Complete Site Download
Puppeteer（Stealth Plugin 付き）でページを開き、HTML/CSS/画像/フォントを全てダウンロード。タイムアウト 150 秒。

### Phase 2: Page-Level Storage
書き換え済み HTML、CSS バンドル、フルページスクリーンショット、アセット一覧を保存。

### Phase 3: Section Detection
ブラウザ内でセマンティック要素を収集。大きすぎる要素は子に分解。

### Phase 4: Classification + Storage
17 種の Block Family に分類し、各セクションを保存。

### Phase 5: Mark Complete
ジョブを完了としてマーク。フロントエンドに結果を返す。

### Phase 6: Background TSX Conversion
Claude CLI（`claude -p`）で各セクションを React TSX に自動変換。3 並列バッチ処理。デザイン完全保持。

---

## 自動クロール

URL リストを `.partcopy/crawl-queue.txt` に記載（1行1URL）するか、UI から一括登録。5 分間隔で自動処理。

```bash
# 例: crawl-queue.txt
https://example.co.jp
https://another-site.jp
https://corporate-site.co.jp
```

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
│   ├── index.ts              # Express API + ZIP エクスポート
│   ├── worker.ts             # Crawl Worker（6 フェーズパイプライン）
│   ├── claude-converter.ts   # Claude TSX 変換（claude -p）
│   ├── auto-crawler.ts       # 自動クロール（URL リスト処理）
│   ├── site-downloader.ts    # サイト完全ダウンロード + URL 書き換え
│   ├── section-detector.ts   # セマンティックセクション検出
│   ├── classifier.ts         # ヒューリスティック分類（17 families）
│   ├── canonicalizer.ts      # スロット/トークン正規化
│   ├── capture-runner.ts     # Puppeteer + Stealth Plugin
│   ├── dom-parser.ts         # 編集可能 DOM スナップショット
│   ├── style-extractor.ts    # スタイル要約 + レイアウトシグネチャ
│   ├── local-store.ts        # ローカル JSON DB（Supabase 代替）
│   └── supabase.ts           # Supabase client 初期化
├── src/
│   ├── App.tsx               # メイン状態管理
│   ├── main.tsx              # React エントリポイント
│   ├── styles.css            # UI スタイル
│   └── components/
│       ├── URLInput.tsx          # URL 入力 + フェーズ進行状況
│       ├── PartsPanel.tsx        # 抽出パーツ一覧（TSX バッジ付き）
│       ├── Canvas.tsx            # 編集キャンバス + ZIP エクスポート
│       ├── TsxModal.tsx          # TSX コード表示 + コピー
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
