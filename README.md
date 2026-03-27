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
- 出荷審査向けの品質レポートと quality gate

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

### 品質レポート / quality gate / quality diff

`collect` と `report` は品質レポートを生成します。  
`gate` は親指標の自動判定 `FAIL` が 1 件でもあると終了コード `2` を返します。  
`gate --baseline <path>` は baseline 比較も行い、親指標の自動指標が `pass -> warn` や `warn -> fail` に悪化した場合も終了コード `2` を返します。`--quality-gate-monitoring-metrics` に入れた指標は差分には出しますが gate では落としません。  
`diff` は baseline の `*_quality_report.json` と比較し、悪化・改善・追加観点を差分化します。差分集計の件数は親指標だけを数え、派生指標は診断用として保持します。

現在は次を自動取込します。

- `tsconfig.json` からの TypeScript 型エラー
- `coverage/lcov.info` などの LCOV
- `junit.xml` / `test-results/*.xml` などの JUnit XML
- `package.json` / `vitest.config.*` / `vitest.workspace.*` からの Vitest 検出
- `reports/axe*.json` などの axe JSON
- `reports/lighthouse*.json` などの Lighthouse JSON
- `playwright-report/results.json` などの Playwright JSON
- `reports/storybook*.json` などの Storybook JSON
- `openapi-diff.json` / `reports/openapi-diff.json` などの OpenAPI diff JSON
- `npm-audit.json` / `reports/npm-audit.json` などの `npm audit --json`
- `trivy.json` / `reports/trivy-results.json` などの Trivy JSON

```bash
node dist/src/cli.js quality collect ./my-app --output ./out --prefix release --format json,markdown,html,csv
node dist/src/cli.js quality gate ./my-app --output ./out --prefix release
node dist/src/cli.js quality gate ./my-app --output ./out --prefix release --baseline ./out/release_quality_report.json
node dist/src/cli.js quality diff ./my-app --output ./out --prefix release --baseline ./out/release_quality_report.json
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
- `--manual-input <path>`: 手動品質証跡 JSON パス
- `--quality-gate-blocking-metrics <ids>`: baseline 回帰で gate を落とす指標 ID のカンマ区切り
- `--quality-gate-monitoring-metrics <ids>`: baseline 回帰を監視専用にする指標 ID のカンマ区切り
- `--help`: ヘルプ

`diff` 専用:

- `--baseline <path>`: 比較元 `*_report.json`
- `--impact-threshold <n>`: impact score 閾値
- `--fail-on-impact`: 閾値超過で終了コード `2`

`quality` 専用:

- `--manual-input <path>`: 手動品質証跡 JSON。未指定時は `<projectDir>/quality.manual.json` を自動読込
- `--baseline <path>`: `quality gate` / `quality diff` の比較元 `*_quality_report.json`
- `--quality-gate-blocking-metrics <ids>`: baseline 回帰で gate を落とす指標 ID
- `--quality-gate-monitoring-metrics <ids>`: baseline 回帰を監視専用にする指標 ID

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

### `quality collect` / `quality report` / `quality gate`

| ファイル | 内容 |
|---|---|
| `<prefix>_quality_report.json` | 出荷審査向けの品質レポートです。12観点ごとの指標、実績、基準、判定、証跡を保持します。証跡の `filePath` は `projectDir` 基準の相対パスに正規化されます |
| `<prefix>_quality_report.md` | 品質報告書向けの Markdown 出力です。統合評価表、`PARTIAL` カテゴリ数、親指標 / 派生指標の区別、観点別詳細を含みます |
| `<prefix>_quality_report.html` | ブラウザ閲覧向けの品質レポートです |
| `<prefix>_quality_summary.csv` | 品質指標の一覧です。カテゴリ、指標、実績、基準、判定、要約を出します |

`quality gate --baseline` を使うと、上記に加えて `quality diff` と同じ差分ファイルも出力します。

### `quality diff`

| ファイル | 内容 |
|---|---|
| `<prefix>_quality_diff.json` | baseline と current の品質差分です。指標ごとの悪化・改善・追加・削除を機械処理向けに保持します。件数集計は親指標のみ、派生指標は診断情報として保持します |
| `<prefix>_quality_diff.md` | リリース比較向けの Markdown 差分です。悪化指標と観点差分をすぐ確認できます |
| `<prefix>_quality_diff.html` | ブラウザ閲覧向けの品質差分レポートです |

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

### 品質レポート

- 12観点の統合評価表
- 親指標と派生指標の分離
- `PARTIAL` 指標と `PARTIAL` カテゴリの明示
- 自動判定可能な指標の PASS / WARN / FAIL
- 手動証跡が必要な指標の明示
- baseline 指定時の自動回帰検知
- TypeScript 型エラー数、循環依存数、型の逃げ道件数
- 対応テストファイル存在率、Unitテスト通過率、LCOV line coverage
- Route / Feature / Form / UI の派生テスト対応率
- JUnit XML 不在時の Vitest 検出シグナル
- Playwright ベースの E2E 通過率、Storybook Interaction テスト通過率
- axe ベースの WCAG 違反件数、Lighthouse Performance / LCP / TTI
- OpenAPI breaking change 数、MSW 採用シグナル、timeout/retry シグナル
- `npm audit` / Trivy ベースの High / Critical 脆弱性判定
- `dangerouslySetInnerHTML`、機密情報露出パターン、ハードコード JSX 文字列
- CI 設定有無、ドキュメント存在、zod 採用率
- 証跡ファイルパスの `projectDir` 基準相対化

### 品質差分レポート

- baseline / current の overall verdict 比較
- 観点ごとの verdict 変化
- 指標ごとの `improved / regressed / neutral`
- 自動悪化件数と手動悪化件数
- 新規追加された指標と削除された指標

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
  "manualInputPath": "./quality.manual.json",
  "qualityGateBlockingMetricIds": ["secret_indicators", "dependency_vulnerabilities"],
  "qualityGateMonitoringMetricIds": ["documentation_presence"],
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
- `ANALYZER_MANUAL_INPUT`
- `ANALYZER_QUALITY_GATE_BLOCKING_METRICS`
- `ANALYZER_QUALITY_GATE_MONITORING_METRICS`

`qualityGateBlockingMetricIds` が空なら、自動指標の回帰はすべて gate 対象です。  
`qualityGateMonitoringMetricIds` に入れた指標は、差分には出しますが gate では落としません。  
両方に同じ指標が入っている場合は `monitoring` を優先します。  
baseline 回帰と `quality diff` の件数集計は親指標だけを数え、派生指標は診断用です。

## 手動品質証跡

自動化できない指標は `quality.manual.json` で補完できます。

```json
{
  "metrics": [
    {
      "id": "requirements_traceability",
      "actual": "100%",
      "threshold": "100%",
      "verdict": "pass",
      "summary": "要件台帳と実装の照合が完了しています。",
      "evidence": [
        {
          "type": "file",
          "label": "requirements",
          "filePath": "./requirements.csv",
          "value": "要件台帳"
        }
      ]
    },
    {
      "id": "residual_bug_count",
      "actual": "High=0, Medium=1, Low=2",
      "threshold": "High=0",
      "verdict": "pass",
      "summary": "重大障害は残存していません。"
    }
  ]
}
```

出力される品質レポートでは、証跡の `filePath` と表示値は `projectDir` 基準の相対パスへ正規化されます。

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
- quality diff 出力

## 注意

- Node.js 標準 API を前提にしているため、古い Node では動かしません
- `diff` は baseline に `*_report.json` を要求します
- `file://` リンクの開き方は利用環境に依存します
