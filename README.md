# ts-react-analyzer

React / TypeScript プロジェクト向けの静的解析 CLI です。  
対象は `.ts` / `.tsx` / `.js` / `.jsx` です。

このツールは次を出します。

- ファイル単位の複雑度
- import / export / dynamic import 依存
- 循環依存、SCC、中心性、hub / fan-out hotspot
- JSON / Markdown / CSV / HTML レポート
- baseline 比較による diff レポート
- impact score による CI ゲート

## 要件

- Node.js 22 以上を推奨
- npm または pnpm

## セットアップ

```bash
npm install
npm run build
```

## 基本コマンド

### 解析

```bash
node dist/src/cli.js analyze <projectDir>
```

例:

```bash
node dist/src/cli.js analyze ./my-app --output ./out --prefix analysis --format json,markdown,html
```

### 依存グラフ出力

```bash
node dist/src/cli.js graph <projectDir>
```

例:

```bash
node dist/src/cli.js graph ./my-app --output ./out --prefix deps
```

### baseline 比較

```bash
node dist/src/cli.js diff <projectDir> --baseline <report.json>
```

例:

```bash
node dist/src/cli.js diff ./my-app --output ./out --prefix analysis --baseline ./out/analysis_report.json
```

### CI ゲート

impact score が閾値以上なら終了コード `2` を返します。

```bash
node dist/src/cli.js diff ./my-app \
  --output ./out \
  --prefix analysis \
  --baseline ./out/analysis_report.json \
  --impact-threshold 60 \
  --fail-on-impact
```

## CLI オプション

全サブコマンド共通:

- `--output <dir>`: 出力ディレクトリ
- `--format <formats>`: `csv,markdown,json,html,all`
- `--config <path>`: 独自設定ファイル
- `--prefix <name>`: 出力ファイル接頭辞
- `--verbose`: 詳細ログ
- `--max-file-size <bytes>`: 解析対象の最大ファイルサイズ
- `--complexity-threshold <n>`: 複雑度警告閾値
- `--exclude-patterns <patterns>`: カンマ区切り正規表現
- `--cache-dir <dir>`: キャッシュディレクトリ
- `--log-file <path>`: ログファイル
- `--help`: ヘルプ

`diff` 専用:

- `--baseline <path>`: 比較元 `*_report.json`
- `--impact-threshold <n>`: impact score 閾値
- `--fail-on-impact`: 閾値超過で終了コード `2`

## 出力ファイル

### `analyze`

| ファイル | 内容 |
|---|---|
| `<prefix>_report.json` | 機械処理向けの完全レポート。統計、decision summary、ファイル別メトリクス、依存、graph metrics、cache stats を含みます |
| `<prefix>_report.md` | 人間が読むためのサマリーレポート。意思決定サマリー、リスク分布、依存分析、優先対応タスクを確認できます |
| `<prefix>_report.html` | ブラウザで見るレポート。依存グラフ、ファイル表、`file://` リンクを含みます |
| `<prefix>_files.csv` | ファイル単位の一覧。`File Type`、`Has Test File`、`Matrix Cluster`、複雑度、依存数、型安全性を出します |
| `<prefix>_dependencies.csv` | import / export / dynamic import の依存一覧。source、target、種別、external、有効 import 名を出します |
| `<prefix>_components.csv` | React コンポーネント単位の一覧。`File Type`、JSX 要素数、Hooks、props 数、render complexity を出します |
| `<prefix>_hooks.csv` | Hook 利用の集計。Hook 名ごとの回数、出現ファイル数、平均引数数、依存配列付き回数を出します |

### `graph`

| ファイル | 内容 |
|---|---|
| `<prefix>_graph.json` | ノード・エッジ・graph metrics を含む依存グラフ JSON です |
| `<prefix>_graph.dot` | Graphviz / DOT 形式です。可視化ツールへそのまま渡せます |

### `diff`

| ファイル | 内容 |
|---|---|
| `<prefix>_diff.json` | baseline と current の差分を機械処理向けに保持します。file diff、graph delta、impact subtree を含みます |
| `<prefix>_diff.md` | 差分の要約レポートです。changed files、hot spot delta、impact score を確認できます |
| `<prefix>_diff.html` | ブラウザで見る差分レポートです。subtree drill-down、priority score、source link を含みます |

## レポート内容

### 解析レポート

- 意思決定サマリー
- hot spot Top 5 と主因（複雑度 / 構造 / 型安全性）
- ファイル数、関数数、コンポーネント数、平均複雑度
- file cache / analysis cache / incremental 再利用統計
- 3x3 マトリクス要約
- File Type 分布
- リスク分布の 3 軸表示
  - 複雑度
  - 構造
  - 型安全性
- 型安全性の詳細
  - `any`
  - assertion
  - non-null assertion
  - `ts-ignore`
- 依存分析
  - 循環依存、SCC、weak cluster、PageRank
  - graph warnings
  - 外部依存の文脈別集計
    - runtime
    - storybook
    - test
    - dev
- HTML での依存グラフ可視化

### diff レポート

- added / removed / changed / unchanged
- 複雑度差分、依存差分、warning 差分
- changed subtree
- impacted files の優先度スコア
- root ごとの subtree metrics
- HTML 上で subtree のフォーカス切り替え

## File Type 分類

`<prefix>_files.csv` と `<prefix>_components.csv` の `File Type` は次のカテゴリを使います。

- `Route`
- `Schema`
- `Feature`
- `Validation`
- `Layout`
- `Form`
- `UI component`
- `Storybook Support`
- `Context/State`
- `Hook`
- `API/Infrastructure`
- `Utils`
- `Type Support`
- `Barrel`
- `Shared`
- `Test`
- `Story`
- `Fixture`
- `Config`

分類はディレクトリ、ファイル名、拡張子、周辺文脈を組み合わせて決めます。  
例として `components/ui/**` は `UI component`、`schemas/**` は `Schema`、`validations/**` は `Validation`、`*.d.ts` は `Type Support` です。

## 設定ファイル

`analyzer.config.json` を `<projectDir>` 直下に置けます。

例:

```json
{
  "outputDir": "./analysis-reports",
  "filePrefix": "analysis",
  "outputFormats": ["json", "markdown", "html"],
  "complexityThreshold": 10,
  "impactScoreThreshold": 60,
  "failOnImpactThreshold": false,
  "maxFileSizeBytes": 10485760,
  "cacheDir": "./.ts-analyzer-cache",
  "logFile": "./analysis.log",
  "excludePatterns": [
    "(?:^|[/\\\\])node_modules(?:$|[/\\\\])",
    "(?:^|[/\\\\])dist(?:$|[/\\\\])"
  ]
}
```

優先順位は次です。

1. デフォルト
2. `analyzer.config.json`
3. `tsconfig.json`
4. CLI 引数
5. `.env`
6. 環境変数

## 環境変数

- `ANALYZER_OUTPUT_DIR`
- `ANALYZER_FORMATS`
- `ANALYZER_PREFIX`
- `ANALYZER_VERBOSE`
- `ANALYZER_CACHE_DIR`
- `ANALYZER_MAX_FILE_SIZE`
- `ANALYZER_COMPLEXITY_THRESHOLD`
- `ANALYZER_IMPACT_SCORE_THRESHOLD`
- `ANALYZER_FAIL_ON_IMPACT_THRESHOLD`
- `ANALYZER_LOG_FILE`

## キャッシュ

2 種類あります。

- file cache: `mtime + SHA256` ベース
- analysis cache: 依存解析結果と複雑度解析結果の永続キャッシュ

同一ソース・同一設定なら 2 回目以降は `reusedFiles` が増えます。

## HTML レポート

- CDN 依存なし
- `file://` リンクでソースに直接飛べる
- `diff.html` は subtree 単位の drill-down に対応

## テスト

```bash
npm test
```

現在のテスト対象:

- path alias 解決
- dynamic import
- complexity / hooks / any 検出
- cycle 検出
- レポート生成
- analysis cache 再利用
- graph 出力
- diff 出力
- impact threshold による失敗コード

## 注意

- Node.js 標準 API を前提にしているため、古い Node では動かしません
- `diff` は baseline に `*_report.json` を要求します
- `file://` リンクの開き方は利用環境に依存します
