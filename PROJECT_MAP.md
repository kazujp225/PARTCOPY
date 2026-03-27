# PARTCOPY プロジェクト一覧

> 最終更新: 2026-03-27

## 概要

PARTCOPYは、複数のWebサイトからデザインパーツ（ヘッダー、ヒーロー、FAQ、フッター等）を抜き出し、
組み合わせてReactプロジェクトとしてエクスポートするツールです。

- **技術スタック**: React 18 + TypeScript + Vite 6 + Express + Puppeteer
- **総コード量**: サーバー約8,900行 / フロントエンド約2,800行
- **リポジトリ**: https://github.com/kazujp225/PARTCOPY.git

---

## ファイル構成

### サーバー (`server/`) — 19ファイル

| ファイル | 行数 | 役割 |
|---------|------|------|
| `index.ts` | ~2,500 | **メインAPI** — エンドポイント定義、ZIPエクスポート、レンダリング |
| `worker.ts` | ~950 | **ワーカー** — 6フェーズパイプライン（クロール→検出→分類→正規化） |
| `local-store.ts` | ~1,400 | **ローカルDB** — Supabaseなしで動くJSON-based ストレージ |
| `site-downloader.ts` | ~450 | **サイト取得** — Puppeteer + Stealthでページ全体をDL |
| `section-detector.ts` | ~510 | **セクション検出** — semantic要素の自動抽出、映像除去 |
| `render-utils.ts` | ~650 | **CSS加工** — スコーピング、URL書き換え、映像ストリップ |
| `dom-parser.ts` | ~280 | **DOM解析** — 編集可能なDOMスナップショット生成 |
| `capture-runner.ts` | ~300 | **キャプチャ** — Puppeteerページ制御 |
| `claude-converter.ts` | ~270 | **TSX変換** — Claude CLIでHTML→React TSX変換 + リトライ |
| `classifier.ts` | ~200 | **分類器** — 17ブロックファミリーのヒューリスティック分類 |
| `canonicalizer.ts` | ~220 | **正規化** — セマンティックスロット+デザイントークン抽出 |
| `network-recorder.ts` | ~180 | **CSS収集** — スタイルシート・フォント・背景画像の収集 |
| `style-extractor.ts` | ~150 | **スタイル要約** — レイアウトシグネチャ抽出 |
| `auto-crawler.ts` | ~150 | **自動クロール** — URLリストからの自動巡回 |
| `keyword-crawler.ts` | ~150 | **キーワード検索** — キーワードベースのURL検索 |
| `patch-engine.ts` | ~100 | **パッチ適用** — DOM編集パッチの実行 |
| `logger.ts` | ~30 | **ログ** — 共通ロガー |
| `storage-config.ts` | ~10 | **設定** — ストレージバケット名 |
| `supabase.ts` | ~20 | **Supabase初期化** — クライアント設定 |

### フロントエンド (`src/`) — 14ファイル

| ファイル | 役割 |
|---------|------|
| `App.tsx` | **メイン画面** — 状態管理、ジョブポーリング、全体レイアウト |
| `components/URLInput.tsx` | **URL入力** — クロール開始、進捗表示 |
| `components/PartsPanel.tsx` | **パーツ一覧** — 検出されたセクションの表示・選択 |
| `components/Canvas.tsx` | **キャンバス** — ドラッグ&ドロップでパーツ配置 |
| `components/Preview.tsx` | **プレビュー** — 組み合わせた結果の統合プレビュー |
| `components/Library.tsx` | **ライブラリ** — 過去のクロール結果をグローバル検索 |
| `components/SectionFrame.tsx` | **セクションiframe** — 読み取り専用プレビュー |
| `components/SourcePreviewFrame.tsx` | **ソースプレビュー** — ライブプレビュー表示 |
| `components/EditableSourceFrame.tsx` | **編集可能iframe** — postMessageでノード編集 |
| `components/NodeInspector.tsx` | **ノードインスペクタ** — 個別要素の編集UI |
| `components/CodeEditor.tsx` | **コードエディタ** — HTML直接編集 |
| `components/TsxModal.tsx` | **TSXモーダル** — TSXコードの表示・コピー |
| `components/Dashboard.tsx` | **ダッシュボード** — プロジェクト管理 |
| `components/ErrorBoundary.tsx` | **エラー処理** — React Error Boundary |
| `types/index.ts` | **型定義** — TypeScript インターフェース |

### スクリプト (`scripts/`) — 6ファイル

| ファイル | 役割 |
|---------|------|
| `sync-from-supabase.ts` | Supabaseからローカルへデータ同期 |
| `cleanup-sections.ts` | 古いセクションデータの掃除 |
| `fix-classifications.ts` | 分類結果の修正バッチ |
| `fix-tsx-linkage.ts` | TSXリンク切れの修正 |
| `backfill-dom-snapshots.ts` | DOMスナップショットの後付け生成 |
| `apply-migration.ts` | DBマイグレーション適用 |

### 設定・ドキュメント

| ファイル | 役割 |
|---------|------|
| `package.json` | 依存関係定義 |
| `vite.config.ts` | Viteビルド設定 |
| `tsconfig.json` | TypeScript設定 |
| `index.html` | HTMLエントリーポイント |
| `ARCHITECTURE.md` | アーキテクチャ設計書 |
| `README.md` | プロジェクト説明 |
| `REVIEW-CODEX.md` | コードレビュー知見 |
| `plan.md` | 開発計画 |

---

## 処理フロー

```
[ユーザー] URL入力
    ↓
[site-downloader] Puppeteerでサイト取得
    ↓
[section-detector] セマンティック要素検出 + 映像除去
    ↓
[classifier] 17分類（hero, nav, footer等）
    ↓
[canonicalizer] スロット・デザイントークン抽出
    ↓
[claude-converter] HTML → React TSX変換（リトライ付き）
    ↓
[index.ts] ZIPエクスポート
    - CSS外部ファイル分離
    - 編集ガイド付きTSX
    - アセット同梱（失敗時placeholder）
    - セクション接合部スタイル
    ↓
[ユーザー] Claude Codeで仕上げ編集
```

---

## 17ブロック分類

| ブロック | 日本語名 |
|---------|---------|
| navigation | ナビゲーション |
| hero | ヒーロー |
| feature | 特徴・サービス |
| social_proof | 導入実績・信頼 |
| stats | 数字・実績 |
| pricing | 料金プラン |
| faq | よくある質問 |
| content | コンテンツ |
| cta | CTA（行動喚起） |
| contact | お問い合わせ |
| recruit | 採用 |
| footer | フッター |
| news_list | お知らせ |
| timeline | 沿革・タイムライン |
| company_profile | 会社概要 |
| gallery | ギャラリー |
| logo_cloud | ロゴ一覧 |
