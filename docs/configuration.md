# 設定リファレンス

毎回 CLI オプションを書かずに済ませたい場合は、解析対象プロジェクトの直下に `analyzer.config.json` を置いてください。  
`node dist/src/cli.js init <projectDir>` を使うと、対話形式で `analyzer.config.json` を生成できます (`--yes` で既定値のまま生成)。

## analyzer.config.json

`<projectDir>/analyzer.config.json` の例:

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

相対パスはすべて `<projectDir>` を基準に解決されます。

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

| 環境変数 | 対応する設定 |
|---|---|
| `ANALYZER_OUTPUT_DIR` | 出力ディレクトリ |
| `ANALYZER_FORMATS` | 出力フォーマット |
| `ANALYZER_PREFIX` | 出力ファイル接頭辞 |
| `ANALYZER_VERBOSE` | 詳細ログ |
| `ANALYZER_CACHE_DIR` | キャッシュディレクトリ |
| `ANALYZER_MAX_FILE_SIZE` | 解析対象の最大ファイルサイズ |
| `ANALYZER_COMPLEXITY_THRESHOLD` | 複雑度の警告閾値 |
| `ANALYZER_IMPACT_SCORE_THRESHOLD` | 影響度スコアの閾値 |
| `ANALYZER_FAIL_ON_IMPACT_THRESHOLD` | 閾値超過で失敗させるか |
| `ANALYZER_LOG_FILE` | ログファイル |
| `ANALYZER_MANUAL_INPUT` | 手動品質証跡 JSON |
| `ANALYZER_QUALITY_GATE_BLOCKING_METRICS` | baseline 悪化で gate を落とす指標 ID |
| `ANALYZER_QUALITY_GATE_MONITORING_METRICS` | baseline 悪化を監視だけに留める指標 ID |

quality gate の blocking / monitoring 指定の意味は [品質レポート](quality.md#baseline-悪化の扱いを指標ごとに変える) を参照してください。

## 既定の出力先

何も指定しない場合、次の場所に出力されます。いずれも `<projectDir>` 基準です。

| 出力 | 既定の場所 |
|---|---|
| レポート | `<projectDir>/analysis-reports/` |
| キャッシュ | `<projectDir>/.ts-analyzer-cache/` |
| ログ | `<projectDir>/analysis.log` |

## 既定の除外対象

次のディレクトリは既定で解析対象から除外されます。

- `node_modules`
- `dist`
- `build`
- `.next`
- `coverage`
- `.git`

さらに除外したい場合は `--exclude-patterns` か `analyzer.config.json` の `excludePatterns` を使ってください。

## キャッシュ

2 回目以降の実行を速くするため、キャッシュは 2 層あります。

- **file cache** — `mtime + SHA256` でファイルの変更を検知します
- **analysis cache** — 依存解析結果と複雑度解析結果を永続化します

同じソース・同じ設定なら 2 回目以降は再計算が減り、レポートの `reusedFiles` が増えます。  
CI では `.ts-analyzer-cache` をキャッシュ対象に含めることを推奨します。
