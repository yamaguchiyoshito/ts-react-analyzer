# コマンドリファレンス

やりたいことから使うコマンドを選んでください。

| やりたいこと | コマンド |
|---|---|
| プロジェクトの現状を把握したい | `analyze` |
| 依存関係だけを図にしたい | `graph` |
| 前回からの悪化だけを確認したい / CI で危険な変更を止めたい | `diff` |
| 出荷前の品質を審査したい | `quality collect` / `quality gate` / `quality diff` |

すべての実行例は、このリポジトリ直下で打つ前提です。  
`--output` などの相対パスは、このツールのディレクトリではなく **解析対象の `<projectDir>` を基準** に解決されます。

## analyze — 現状を把握する

複雑度、依存関係、hot spot、ディレクトリ目的の整合チェックをまとめて解析します。

```bash
node dist/src/cli.js analyze <projectDir>
```

実用例:

```bash
node dist/src/cli.js analyze ./my-app \
  --output ./reports \
  --prefix main \
  --format json,markdown,html,csv
```

この例の出力先は `./my-app/reports` です。

## graph — 依存グラフを出力する

依存グラフ専用の出力です。可視化ツールに渡せる DOT 形式も出ます。

```bash
node dist/src/cli.js graph <projectDir> --output ./reports --prefix deps
```

出力は `deps_graph.json` と `deps_graph.dot` です。  
**`graph` は `--format` を見ません。** JSON と DOT を必ず出します。HTML で見たい場合は `analyze` を使ってください。

## diff — 前回からの変化を確認する

baseline (前回の `*_report.json`) と現在を比較し、悪化した箇所を影響度スコア付きで出します。

```bash
node dist/src/cli.js diff <projectDir> --baseline <report.json>
```

CI で危険な変更を自動的に止める例:

```bash
node dist/src/cli.js diff ./my-app \
  --output ./reports \
  --prefix pr \
  --baseline ./my-app/reports/main_report.json \
  --impact-threshold 60 \
  --fail-on-impact
```

影響度スコアが 60 以上のファイルが 1 件でもあれば終了コード `2` で失敗します。

補足:

- `--baseline` を省略すると `<outputDir>/<prefix>_report.json` を読みます
- 差分ファイル (JSON / Markdown / HTML) は `--format` に関係なく常に生成されます
- 実行時に現在状態の `*_report.*` も同時に更新されます

## quality — 出荷前の品質を審査する

```bash
node dist/src/cli.js quality collect <projectDir>   # 品質レポートを生成する
node dist/src/cli.js quality gate <projectDir>      # 出荷可否を機械判定する
node dist/src/cli.js quality diff <projectDir> --baseline <quality_report.json>  # 前回リリースと比較する
```

- `collect` と `report` は同じ動作です (どちらも品質レポート生成)
- `gate` は自動判定 `FAIL` の親指標が 1 件でもあると終了コード `2` で失敗します
- `gate --baseline <path>` は前回からの悪化 (例: `pass -> warn`) も検知して失敗します
- 判定の仕組みと手動証跡は [品質レポート](quality.md) を参照してください

実用例:

```bash
node dist/src/cli.js quality collect ./my-app --output ./reports --prefix release --format json,markdown,html,csv
node dist/src/cli.js quality gate ./my-app --output ./reports --prefix release \
  --baseline ./my-app/reports/release_quality_report.json
```

## オプション一覧

### 全サブコマンド共通

| オプション | 意味 |
|---|---|
| `--output <dir>` | 出力ディレクトリ (`<projectDir>` 基準) |
| `--format <formats>` | `csv,markdown,json,html,all` |
| `--config <path>` | 設定ファイルのパス |
| `--prefix <name>` | 出力ファイルの接頭辞 |
| `--verbose` | 詳細ログを有効化 |
| `--max-file-size <bytes>` | 指定サイズ超のファイルを解析から除外 |
| `--complexity-threshold <n>` | 複雑度の警告閾値 |
| `--exclude-patterns <patterns>` | 除外パターン (カンマ区切り正規表現) |
| `--cache-dir <dir>` | キャッシュディレクトリ |
| `--log-file <path>` | ログファイルのパス |
| `--manual-input <path>` | 手動品質証跡 JSON のパス |
| `--quality-gate-blocking-metrics <ids>` | baseline 悪化で gate を落とす指標 ID (カンマ区切り) |
| `--quality-gate-monitoring-metrics <ids>` | baseline 悪化を監視だけに留める指標 ID (カンマ区切り) |
| `--help` | ヘルプを表示 |

### diff 専用

| オプション | 意味 |
|---|---|
| `--baseline <path>` | 比較元の `*_report.json` |
| `--impact-threshold <n>` | 影響度スコアの閾値 |
| `--fail-on-impact` | 閾値超過で終了コード `2` |

### quality 専用

| オプション | 意味 |
|---|---|
| `--manual-input <path>` | 手動品質証跡 JSON。未指定時は `<projectDir>/quality.manual.json` を自動で読みます |
| `--baseline <path>` | `quality gate` / `quality diff` の比較元 `*_quality_report.json` |
| `--quality-gate-blocking-metrics <ids>` | baseline 悪化で gate を落とす指標 ID |
| `--quality-gate-monitoring-metrics <ids>` | baseline 悪化を監視だけに留める指標 ID |

## 終了コード

CI に組み込むときは `2` を明示的に拾ってください。

| コード | 意味 |
|---|---|
| `0` | 成功 |
| `1` | 実行失敗 (パス誤りなどの一般エラー) |
| `2` | 判定による失敗 — `diff` の影響度閾値超過、または `quality gate` の出荷判定 NG |
