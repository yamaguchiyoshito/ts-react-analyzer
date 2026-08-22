# 出力リファレンス

各コマンドが出力するファイルと、そこから何が分かるかをまとめます。  
迷ったら、まず Markdown (`*_report.md` / `*_diff.md`) から読み始めてください。読み進め方は [運用ガイド](guide.md) にあります。

## analyze の出力

| ファイル | 何が分かるか |
|---|---|
| `<prefix>_report.md` | 最初に読むサマリー。優先対応 Top 5、リスク分布、依存分析、ディレクトリ目的の改善提案 |
| `<prefix>_report.html` | ブラウザで見るレポート。依存グラフの可視化、ファイル表、ソースへの `file://` リンク |
| `<prefix>_report.json` | 機械処理向けの完全データ。統計、decision summary、ファイル別メトリクス、依存、graph metrics、cache stats、`directoryPurposeAudit` |
| `<prefix>_files.csv` | ファイル単位の横比較。`File Type`、テストファイル有無、`Matrix Cluster`、複雑度、依存数、型安全性 |
| `<prefix>_dependencies.csv` | import / export / dynamic import の一覧。循環依存や fan-out の根拠確認に |
| `<prefix>_components.csv` | React コンポーネント単位の一覧。JSX 要素数、Hooks、props 数、render complexity |
| `<prefix>_hooks.csv` | Hook 利用の集計。Hook 名ごとの回数、出現ファイル数、依存配列の指定率 |

### 解析レポート (report.md / report.json) に載っている情報

- 意思決定サマリー — 最初の 30 秒で読むべき情報
- hot spot Top 5 と主因 (複雑度 / 構造 / 型安全性)
- ファイル数、関数数、コンポーネント数、平均複雑度
- リスク分布の 3 軸表示 (複雑度・構造・型安全性)
- 型安全性の詳細 (`any`、assertion、non-null assertion、`ts-ignore`)
- 依存分析 — 循環依存、SCC、weak cluster、PageRank、graph warnings
- 外部依存の文脈別集計 (runtime / storybook / test / dev)
- 3x3 マトリクス要約と File Type 分布
- ディレクトリ目的の定義表と、目的整合の改善提案 (→ [File Type とディレクトリ目的](file-types.md))
- file cache / analysis cache / incremental の再利用統計

## graph の出力

| ファイル | 何が分かるか |
|---|---|
| `<prefix>_graph.json` | ノード・エッジ・graph metrics を含む依存グラフ |
| `<prefix>_graph.dot` | Graphviz / DOT 形式。可視化ツールへそのまま渡せます |

## diff の出力

| ファイル | 何が分かるか |
|---|---|
| `<prefix>_diff.md` | 今回の変更の影響サマリー。changed files、hot spot delta、影響度スコア |
| `<prefix>_diff.html` | 影響サブツリーの可視化。subtree の drill-down、優先度スコア、ソースリンク |
| `<prefix>_diff.json` | 差分の完全データ。file diff、graph delta、impact subtree |

### diff レポートに載っている情報

- added / removed / changed / unchanged の内訳
- 複雑度差分、依存差分、warning 差分
- 変更の影響が波及するサブツリー (changed subtree)
- 影響を受けるファイルの優先度スコア
- root ごとの subtree metrics

## quality collect / report / gate の出力

| ファイル | 何が分かるか |
|---|---|
| `<prefix>_quality_report.md` | 品質報告書向けサマリー。12 観点の統合評価表、`PARTIAL` カテゴリ、親指標 / 派生指標の区別、観点別詳細 |
| `<prefix>_quality_report.html` | ブラウザ閲覧向けの品質レポート |
| `<prefix>_quality_report.json` | 機械処理向けの完全データ。指標・実績・基準・判定・証跡 (証跡パスは `<projectDir>` 基準の相対パス) |
| `<prefix>_quality_summary.csv` | 品質指標の一覧。カテゴリ、指標、実績、基準、判定、要約 |

`quality gate --baseline` を使うと、上記に加えて `quality diff` と同じ差分ファイルも出力されます。  
レポートに載る指標の詳細は [品質レポート](quality.md) を参照してください。

## quality diff の出力

| ファイル | 何が分かるか |
|---|---|
| `<prefix>_quality_diff.md` | 前回リリース比の悪化を最初に確認するサマリー |
| `<prefix>_quality_diff.html` | ブラウザ閲覧向けの品質差分 |
| `<prefix>_quality_diff.json` | 指標ごとの悪化・改善・追加・削除の完全データ。件数集計は親指標のみ、派生指標は診断用 |

### 品質差分レポートに載っている情報

- baseline / current の総合判定 (overall verdict) の比較
- 観点ごとの判定変化
- 指標ごとの `improved / regressed / neutral`
- 自動判定の悪化件数と手動判定の悪化件数
- 新規追加された指標と削除された指標

## HTML レポートの特徴

- CDN に依存しないため、社内ネットワークでもそのまま開けます
- ファイル名をクリックすると `file://` リンクでソースに直接飛べます
- `diff.html` は影響サブツリー単位の drill-down に対応しています
- 依存グラフの表示は次数上位 300 ノードまでに制限されます (全量は JSON に保持)

## レポート内のパス表記

`*_report.json` のファイルパス・依存・グラフ ID は `projectDir` 基準の相対パスで保存されます。CI のワークスペースパスが実行ごとに変わっても、baseline 比較はそのまま成立します (旧形式の絶対パス baseline も同一マシン上なら自動で相対化して比較されます)。
