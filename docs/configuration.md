# 設定リファレンス

毎回 CLI オプションを書かずに済ませたい場合は、解析対象プロジェクトの直下に `analyzer.config.json` を置いてください。  
`node dist/src/cli.js init <projectDir>` を使うと、対話形式で `analyzer.config.json` を生成できます (`--yes` で既定値のまま生成)。

## analyzer.config.json

`<projectDir>/analyzer.config.json` の例:

```json
{
  "analysisScope": "all",
  "qualityProfile": "application",
  "outputDir": "./analysis-reports",
  "filePrefix": "analysis",
  "outputFormats": ["json", "markdown", "html"],
  "complexityThreshold": 10,
  "impactScoreThreshold": 60,
  "failOnImpactThreshold": false,
  "maxFileSizeBytes": 10485760,
  "maxTypeCheckRootNames": 5000,
  "cacheDir": "./.ts-analyzer-cache",
  "logFile": "./analysis.log",
  "manualInputPath": "./quality.manual.json",
  "qualityGateBlockingMetricIds": ["secret_indicators", "dependency_vulnerabilities"],
  "qualityGateMonitoringMetricIds": ["documentation_presence"],
  "excludeGroups": ["package-distribution"],
  "excludePatterns": [
    "^src/legacy/"
  ]
}
```

相対パスはすべて `<projectDir>` を基準に解決されます。

受け付けるキーは次のとおりです。未知のキーがあると `警告: ... に未知の設定キーがあります` と表示されます (typo に気づけるように)。

| キー | 型 | 既定値 | 対応する CLI オプション |
|---|---|---|---|
| `analysisScope` | `"all"` \| `"source-only"` | `"all"` | `--analysis-scope` |
| `qualityProfile` | `"application"` \| `"library-repo"` | `"application"` | `--quality-profile` |
| `outputDir` | string | `"./analysis-reports"` | `--output` |
| `filePrefix` | string | `"analysis"` | `--prefix` |
| `outputFormats` | string[] | `["json", "markdown", "csv"]` | `--format` |
| `complexityThreshold` | 0 以上の整数 | `12` | `--complexity-threshold` |
| `impactScoreThreshold` | 0 以上の整数 | `0` | `--impact-threshold` |
| `failOnImpactThreshold` | boolean | `false` | `--fail-on-impact` |
| `maxFileSizeBytes` | 0 以上の整数 | `10485760` | `--max-file-size` |
| `maxTypeCheckRootNames` | 0 以上の整数 | `5000` | `--max-typecheck-root-names` |
| `verbose` | boolean | `false` | `--verbose` |
| `enableCache` | boolean | `true` | (なし) |
| `cacheDir` | string | `"./.ts-analyzer-cache"` | `--cache-dir` |
| `logFile` | string | `"./analysis.log"` | `--log-file` |
| `manualInputPath` | string | (未指定 = `<projectDir>/quality.manual.json`) | `--manual-input` |
| `qualityGateBlockingMetricIds` | string[] | `[]` | `--quality-gate-blocking-metrics` |
| `qualityGateMonitoringMetricIds` | string[] | `[]` | `--quality-gate-monitoring-metrics` |
| `excludeGroups` | string[] | 既定グループ (→ [既定の除外対象](#既定の除外対象)) に**追加**される | `--exclude-groups` |
| `excludePatterns` | string[] (正規表現) | `[]` (既定グループのパターンに**追加**される) | `--exclude-patterns` |
| `testPresenceSettings` | object | (→ [品質レポート](quality.md)) | (なし) |

`--quiet` / `-q` は画面出力だけを変える CLI 専用のスイッチで、設定ファイルや環境変数では指定できません。

## 設定の優先順位

同じ項目を複数の場所で指定した場合は後勝ちです。

1. デフォルト値
2. `analyzer.config.json`
3. `tsconfig.json`
4. `.env`
5. 環境変数
6. CLI 引数（最優先）

> **v0.2.0 の変更 (破壊的変更)**: 以前は環境変数が CLI 引数より優先されました。v0.2.0 から一般的な CLI の慣習に合わせ、**CLI 引数が最優先** です。CI で `ANALYZER_*` を設定したままコマンドラインで別の値を指定した場合は CLI 側が使われ、食い違いがあるときは実行時に「注意: CLI 引数 ... が環境変数 ... より優先されます」と表示されます。旧仕様の動作に依存していた場合は、CLI 引数の指定を外すか環境変数側を更新してください。

## 環境変数

`<projectDir>/.env` に書いた同名の変数も読み込まれます (環境変数の方が優先)。

| 環境変数 | 対応する設定 | 値 |
|---|---|---|
| `ANALYZER_ANALYSIS_SCOPE` | 解析範囲 (`analysisScope`) | `all` \| `source-only` |
| `ANALYZER_QUALITY_PROFILE` | 品質プロファイル (`qualityProfile`) | `application` \| `library-repo` |
| `ANALYZER_EXCLUDE_GROUPS` | 追加する除外グループ (`excludeGroups`) | グループ名のカンマ区切り |
| `ANALYZER_OUTPUT_DIR` | 出力ディレクトリ | パス |
| `ANALYZER_FORMATS` | 出力フォーマット | `csv,markdown,json,html,all` のカンマ区切り |
| `ANALYZER_PREFIX` | 出力ファイル接頭辞 | 文字列 |
| `ANALYZER_VERBOSE` | 詳細ログ | `true` で有効 |
| `ANALYZER_CACHE_DIR` | キャッシュディレクトリ | パス |
| `ANALYZER_MAX_FILE_SIZE` | 解析対象の最大ファイルサイズ | 0 以上の整数 (バイト) |
| `ANALYZER_COMPLEXITY_THRESHOLD` | 複雑度の警告閾値 | 0 以上の整数 |
| `ANALYZER_IMPACT_SCORE_THRESHOLD` | 影響度スコアの閾値 | 0 以上の整数 |
| `ANALYZER_FAIL_ON_IMPACT_THRESHOLD` | 閾値超過で失敗させるか | `true` で有効 |
| `ANALYZER_LOG_FILE` | ログファイル | パス |
| `ANALYZER_MANUAL_INPUT` | 手動品質証跡 JSON | パス |
| `ANALYZER_QUALITY_GATE_BLOCKING_METRICS` | baseline 悪化で gate を落とす指標 ID | 指標 ID のカンマ区切り |
| `ANALYZER_QUALITY_GATE_MONITORING_METRICS` | baseline 悪化を監視だけに留める指標 ID | 指標 ID のカンマ区切り |
| `ANALYZER_MAX_TYPECHECK_ROOT_NAMES` | TypeScript 型検査に渡すルートファイル数の上限 (`maxTypeCheckRootNames`) | 0 以上の整数 |

数値や列挙値が不正な場合 (例: `ANALYZER_IMPACT_SCORE_THRESHOLD=abc`) は黙って無視せず、理由を表示して終了コード `1` で止まります。  
quality gate の blocking / monitoring 指定の意味は [品質レポート](quality.md#baseline-悪化の扱いを指標ごとに変える) を参照してください。

## 既定の出力先

何も指定しない場合、次の場所に出力されます。いずれも `<projectDir>` 基準です。

| 出力 | 既定の場所 |
|---|---|
| レポート | `<projectDir>/analysis-reports/` |
| キャッシュ | `<projectDir>/.ts-analyzer-cache/` |
| ログ | `<projectDir>/analysis.log` |

## 既定の除外対象

除外対象は「除外グループ」としてまとめられており、次のグループが既定で有効です。グループ名は `--exclude-groups` / `ANALYZER_EXCLUDE_GROUPS` / `excludeGroups` で追加指定できます (指定は既定グループへの**追加**で、既定グループを外すオプションはありません)。

| グループ | 既定 | 除外されるディレクトリ (プロジェクト相対パスのどの階層でも一致) |
|---|---|---|
| `dependencies` | 有効 | `node_modules` |
| `build-output` | 有効 | `dist`, `build`, `.next`, `out`, `.output` |
| `coverage` | 有効 | `coverage`, `.nyc_output` |
| `vcs` | 有効 | `.git` |
| `storybook-assets` | 有効 | `storybook-static/assets` |
| `deployment-artifacts` | 有効 | `.firebase`, `.vercel`, `.netlify` |
| `tool-cache` | 有効 | `.turbo`, `.cache`, `.parcel-cache` |
| `package-distribution` | 無効 (明示指定で有効) | `lib/esm`, `lib/cjs`, `lib/modern`, および `esm`, `cjs`, `umd` という名前のディレクトリ |

各グループの正規表現は `(?:^|[/\\])<名前>(?:$|[/\\])` の形です (例: `build-output` の `out` は `(?:^|[/\\])out(?:$|[/\\])` で、`checkout.ts` のような部分一致はしません)。

`package-distribution` はライブラリの配布物 (`lib/esm` など) を持つモノレポ向けで、`esm` / `cjs` / `umd` という名前のソースディレクトリまで除外してしまうため既定では無効です。必要なときだけ `--exclude-groups package-distribution` を付けてください。

除外パターン (既定グループも `excludePatterns` も) は、解析対象ディレクトリ (`projectDir`) からの**プロジェクト相対パス**にスラッシュ区切りで照合されます (例: `src/components/Button.tsx`、ディレクトリなら `src/build`)。プロジェクトより上位のディレクトリ名は照合対象にならないため、`/tmp/build/app` のような場所にあるプロジェクトでも既定の `build` 除外には巻き込まれません。逆に `src/build/` のようなプロジェクト内部のディレクトリは既定の `build` 除外に一致します (除外されたファイルは `analyze` の結果サマリーとレポートの「除外されたファイル」に件数が出ます)。

さらに除外したい場合は `--exclude-patterns` か `analyzer.config.json` の `excludePatterns` を使ってください (例: `^src/legacy/`)。パターンは JavaScript の正規表現で、Windows でも区切りは `/` で書いてください (`\\` 区切りには一致しません)。正規表現として不正なパターンは文字列そのままの一致として扱われ、その旨がスキャン結果の `warnings` に記録されます。

## キャッシュ

2 回目以降の実行を速くするため、キャッシュは 2 層あります。

- **file cache** — `mtime + SHA256` でファイルの変更を検知します
- **analysis cache** — 依存解析結果と複雑度解析結果を永続化します

同じソース・同じ設定なら 2 回目以降は再計算が減り、レポートの `reusedFiles` が増えます。  
CI では `.ts-analyzer-cache` をキャッシュ対象に含めることを推奨します。

解析対象プロジェクトには `analysis-reports/`、`.ts-analyzer-cache/`、`analysis.log` が書き込まれます。リポジトリにコミットしないよう、対象プロジェクトの `.gitignore` に次を追加してください。

```gitignore
analysis-reports/
.ts-analyzer-cache/
analysis.log
```
