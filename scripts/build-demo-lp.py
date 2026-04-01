#!/usr/bin/env python3
"""
Build demo LP: replace text in merged HTML to create a fictional SaaS landing page.
No API calls - pure local text replacement.
"""
import re
import sys

def replace_in_html(html: str, old: str, new: str) -> str:
    """Replace text that appears between HTML tags, preserving tags."""
    return html.replace(old, new)

def main():
    with open('/tmp/demo-raw.html', 'r', encoding='utf-8') as f:
        html = f.read()

    # ============================================================
    # Section 1: Hero (ntt-f.co.jp)
    # ============================================================
    html = replace_in_html(html, '新しい働き方を創る', 'ビジネスを加速する')
    html = replace_in_html(html, '詳しくはこちら', '無料で始める')
    html = replace_in_html(html,
        '省エネとウェルビーイングを両立したワークプレイスの構築や企業内エンゲージメントを高めるオフィス環境づくりなどを提案。多様な働き方による知的生産性向上を実現します。',
        'CloudFlowは、プロジェクト管理・タスク共有・チームコミュニケーションを一つのプラットフォームに統合。チームの生産性を最大化し、ビジネスの成長を加速します。')

    # ============================================================
    # Section 2: Features (zeon.co.jp)
    # ============================================================
    html = replace_in_html(html, '主な製品特徴', 'CloudFlowの特長')
    html = replace_in_html(html, 'FEATURES', 'FEATURES')
    html = replace_in_html(html, '各製品特徴の試験データは', '導入企業の声は')
    html = replace_in_html(html, 'マルチマテリアル接着性', 'リアルタイム共同編集')
    html = replace_in_html(html, '多様な材料と異材接合が可能', 'チーム全員が同時にドキュメントを編集')
    html = replace_in_html(html, '耐水性', 'セキュリティ')
    html = replace_in_html(html, 'に優れる', 'が万全')
    html = replace_in_html(html, '吸湿性が低い', 'SOC2 Type II 認証取得済み')
    html = replace_in_html(html, '加水分解しない', 'エンドツーエンド暗号化対応')
    html = replace_in_html(html, '耐電食性', 'AI自動化')
    html = replace_in_html(html, '絶縁性が高い', 'ルーティン業務を自動で処理')
    html = replace_in_html(html, '衝撃', 'スケーラビリティ')
    html = replace_in_html(html, '柔軟で伸びに優れる', '10人から10,000人まで対応')
    html = replace_in_html(html, '易解体性', 'API連携')
    html = replace_in_html(html, 'リサイクル性に優れる', '500以上の外部ツールと連携可能')
    html = replace_in_html(html, '低誘電性', 'モバイル対応')
    html = replace_in_html(html, '誘電性が低いため伝送損失を低減できる', 'iOS/Android アプリで外出先からも管理')

    # Use cases
    html = replace_in_html(html, '用途例', '活用シーン')
    html = replace_in_html(html, 'モビリティ用構造・準構造接着として', 'スタートアップのプロジェクト管理に')
    html = replace_in_html(html, '高接着性', 'タスク管理')
    html = replace_in_html(html, '高信頼性', 'スプリント計画')
    html = replace_in_html(html, '高絶縁性', 'レポート自動生成')
    html = replace_in_html(html, '易解体性', 'API連携')
    html = replace_in_html(html, 'モーター用絶縁フィルムとして', 'エンタープライズのワークフロー統合に')
    html = replace_in_html(html, '高周波基板材料として', 'リモートチームのコミュニケーション基盤に')
    html = replace_in_html(html, '低誘電性', 'モバイル対応')
    html = replace_in_html(html, '低吸水率', 'オフライン対応')

    # ============================================================
    # Section 3: Stats (sugi-hd.co.jp)
    # ============================================================
    html = replace_in_html(html, '数字で見る', '数字で見る')  # keep
    html = replace_in_html(html, 'スギ薬局グループ', 'CloudFlow')
    html = replace_in_html(html, 'お客様', '導入実績')
    html = replace_in_html(html, '財務', 'パフォーマンス')
    html = replace_in_html(html, '職場環境', 'チーム')
    html = replace_in_html(html, 'その他', '成長')
    html = replace_in_html(html, 'ポイント会員数', '利用ユーザー数')
    html = replace_in_html(html, '2,376', '120')
    html = replace_in_html(html, '年間延来店客数', '月間アクティブプロジェクト')
    html = replace_in_html(html, '3.7', '85')
    html = replace_in_html(html, '億人', '万件')
    html = replace_in_html(html, 'スギ薬局', 'CloudFlow')
    html = replace_in_html(html, 'グループ店舗数', '導入企業数')
    html = replace_in_html(html, '2,207', '3,500')
    html = replace_in_html(html, '連結売上高', 'ARR（年間経常収益）')
    html = replace_in_html(html, '8,780', '42')
    html = replace_in_html(html, '億円', '億円')
    html = replace_in_html(html, '薬剤師', 'エンジニア')
    html = replace_in_html(html, '4,820', '280')
    html = replace_in_html(html, '調剤併設率', 'API稼働率')
    html = replace_in_html(html, '79.9', '99.99')
    html = replace_in_html(html, '処方せん応需枚数', '月間API呼び出し')
    html = replace_in_html(html, '1,956', '12')
    html = replace_in_html(html, '万枚', '億回')
    html = replace_in_html(html, '再生可能エネルギー', 'カスタマーサクセス')
    html = replace_in_html(html, '導入店舗数', 'NPS スコア')
    html = replace_in_html(html, '234', '72')
    html = replace_in_html(html, '店舗', 'pt')
    html = replace_in_html(html, '自治体との協定数', 'パートナー企業数')
    html = replace_in_html(html, '159', '450')
    html = replace_in_html(html, '件', '社')
    html = replace_in_html(html, '出店エリアと店舗数推移', '成長の軌跡を見る')
    # Remove update dates
    html = re.sub(r'最終更新日：\d{4}\.\d{2}\.\d{2}', '', html)

    # ============================================================
    # Section 4: Values/Social Proof (yelp)
    # ============================================================
    html = replace_in_html(html, 'Our values', '私たちの約束')
    html = replace_in_html(html,
        'Since Yelp was founded, our values have remained the same. They are the guiding force for the many experiences that are created at Yelp. They provide the framework for who we hire, who we promote, and how we get things done.',
        'CloudFlowは創業以来、お客様の成功を最優先に考えてきました。これらの価値観が、私たちのプロダクト開発とサービス提供の基盤です。')
    html = replace_in_html(html, 'Be tenacious.', 'スピードを追求する')
    html = replace_in_html(html, "Battle smart and fight 'til the end. Live for the underdog moments. Turn mistakes into opportunities to learn.",
        'お客様の課題を最速で解決します。フィードバックから24時間以内に改善をリリース。')
    html = replace_in_html(html, 'Play well with others.', 'チームで勝つ')
    html = replace_in_html(html, 'Treat others with respect. Value diversity in viewpoints. Bring a positive attitude to the table.',
        '多様なバックグラウンドを持つチームが、あらゆる角度からソリューションを設計します。')
    html = replace_in_html(html, 'Be unboring.', 'シンプルを極める')
    html = replace_in_html(html, 'Never settle for standard. Creativity over conformity. Be your remarkable self.',
        '複雑な業務も直感的なUIで。マニュアル不要、導入初日から生産性向上を実感。')
    html = replace_in_html(html, 'Protect the source.', 'セキュリティファースト')
    html = replace_in_html(html, "Community and consumers come first. If we don't maintain consumer trust, we won't have anything to offer local businesses.",
        'お客様のデータは最高水準のセキュリティで保護。ISO 27001, SOC2 Type II認証取得。')
    html = replace_in_html(html, 'Authenticity.', '透明性を貫く')
    html = replace_in_html(html, "Tell the truth. Be straightforward and over-communicate.\nNo need to spin things.",
        '料金体系は明朗。隠れたコストなし。ダウンタイムはリアルタイムでステータスページに公開。')
    html = replace_in_html(html, "Tell the truth. Be straightforward and over-communicate. No need to spin things.",
        '料金体系は明朗。隠れたコストなし。ダウンタイムはリアルタイムでステータスページに公開。')

    # ============================================================
    # Section 5: FAQ (tokiomarine)
    # ============================================================
    html = replace_in_html(html, '自動車保険に関する', 'CloudFlowに関する')
    html = replace_in_html(html, 'よくあるご質問', 'よくあるご質問')
    html = replace_in_html(html, '車を買い替えました。保険の変更手続きは必要ですか？', '無料プランから有料プランへのアップグレード方法は？')
    html = replace_in_html(html, '「記名被保険者」とは何ですか？', 'チームメンバーの追加・削除はどうすればできますか？')
    html = replace_in_html(html, '「人身傷害保険」と「搭乗者傷害特約(一時払)」の違いを教えてください。', 'ProプランとEnterpriseプランの違いを教えてください。')
    html = replace_in_html(html, '個人賠償責任補償特約の補償内容を教えてください。', 'データのエクスポートは可能ですか？')
    html = replace_in_html(html, '「ノンフリート等級別割引・割増制度」とはどのような制度ですか？', 'SLA（サービスレベル契約）の内容を教えてください。')
    html = replace_in_html(html, 'もっと見る', 'すべてのFAQを見る')

    # ============================================================
    # Section 6: CTA (zoomcorp)
    # ============================================================
    html = replace_in_html(html, '関連製品', '今すぐ始めましょう')
    html = replace_in_html(html, 'H1essential', 'CloudFlow Free')
    html = replace_in_html(html, '32bitフロート対応、XYステレオマイク搭載ハンディレコーダー', '3プロジェクトまで無料・チームメンバー5人まで・基本機能すべて利用可能')
    html = replace_in_html(html, '12300', '¥0')
    html = replace_in_html(html, '今すぐ購入', '無料で始める')

    # ============================================================
    # Global cleanup
    # ============================================================
    # Remove references to original companies
    html = replace_in_html(html, 'NTT', 'CloudFlow')
    html = replace_in_html(html, 'Yelp', 'CloudFlow')
    html = replace_in_html(html, 'ZOOM', 'CloudFlow')
    html = replace_in_html(html, 'ZEON', 'CloudFlow')

    # Update page title
    html = html.replace('<html lang="ja">', '<html lang="ja">')
    html = html.replace('</head>', '<title>CloudFlow - ビジネスを加速するプロジェクト管理</title></head>')

    with open('/Users/zettai/Downloads/PARTCOPY-main/demo-lp.html', 'w', encoding='utf-8') as f:
        f.write(html)

    print(f"Done! Output: demo-lp.html ({len(html):,} bytes)")

if __name__ == '__main__':
    main()
