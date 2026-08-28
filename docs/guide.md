# 運用ガイド

導入から毎日の使い方、レポートの読み方までを、実際の作業の流れに沿ってまとめます。  
個々のオプションや出力ファイルの仕様は [コマンドリファレンス](commands.md) と [出力リファレンス](outputs.md) を参照してください。

## はじめに押さえておく仕様

つまずきやすいポイントを先にまとめます。

- `--output ./reports` などの相対パスは、このツールのディレクトリではなく **解析対象の `<projectDir>` 基準** で解決されます
- 既定の出力先は `<projectDir>/analysis-reports`、キャッシュは `<projectDir>/.ts-analyzer-cache`、ログは `<projectDir>/analysis.log` です
- `graph` は `--format` の指定に関係なく、常に JSON と DOT を出力します
- `diff` で `--baseline` を省略すると `<outputDir>/<prefix>_report.json` を読みます
- CI の判定は終了コード `2` (判定による失敗) を明示的に拾ってください (→ [終了コード](commands.md#終了コード))
- v0.2.0 から CLI 引数が環境変数より優先されます (→ [設定の優先順位](configuration.md#設定の優先順位))

## 導入初日にやること — 設定と基準点を作る

まず `init` で設定ファイルを対話形式で作ると、以後のコマンドからオプション指定を省けます。

```bash
node dist/src/cli.js init ./target-app
```

続いて現状を解析して、以後の比較に使う baseline を作ります。

```bash
node dist/src/cli.js analyze ./target-app --output ./analysis --prefix baseline
node dist/src/cli.js graph ./target-app --output ./analysis --prefix baseline
```

生成された `baseline_report.json` は以後の `diff` の比較元になるので保管してください。

## 毎日 / PR ごとの使い方 — 悪化だけを見る

```bash
node dist/src/cli.js diff ./target-app \
  --output ./analysis \
  --prefix current \
  --baseline ./target-app/analysis/baseline_report.json
```

読む順番は固定です。

1. `current_diff.md` — 今回の変更で何が悪化したか
2. `current_diff.html` — 影響範囲をグラフで確認
3. `current_report.md` — 全体のサマリー
4. `current_files.csv` — 負債候補の横比較
5. `current_dependencies.csv` — 依存の根拠確認

差分を先に見るのは、単に絶対値が大きいだけのファイルと、今回の変更で危険になったファイルを混ぜないためです。

その場で深掘りしたいときは、詳細ログ付きで単発解析するのが手早いです。`--open` を付けると生成した HTML レポートがそのままブラウザで開きます。

```bash
node dist/src/cli.js analyze ../frontend --output ./analysis --prefix local --verbose --open
```

リファクタリング中に「悪化していないか」を確認し続けたいときは、`diff --watch` が便利です。ファイルを保存するたびに diff が自動で再実行されます。

```bash
node dist/src/cli.js diff ../frontend --baseline ./analysis/baseline_report.json --watch
```

依存構造だけを棚卸ししたいときは `graph` を使います。

```bash
node dist/src/cli.js graph ../frontend --output ./analysis --prefix architecture
```

## 対応の優先順位の付け方

次のシグナルが出ている箇所から潰すと、単なるコード量ではなく変更コストが高い箇所から対応できます。

1. `diff` の impacted files でスコアが高い
2. `report.md` の hot spot Top 5 に入っている
3. `files.csv` で `Matrix Cluster` が `S3` (小規模・高複雑度) に寄っている (コードの読み方は → [用語集](glossary.md#クラスタコード))
4. graph warnings に循環依存、hub、fan-out が出ている
5. 型安全性で `any`、assertion、non-null assertion、`ts-ignore` が多い
6. 「ディレクトリ目的と改善提案」に severity `high` の不整合が出ている

## リリース前の使い方 — 出荷審査

```bash
node dist/src/cli.js quality collect ./target-app --output ./analysis --prefix release
node dist/src/cli.js quality gate ./target-app \
  --output ./analysis \
  --prefix release \
  --baseline ./target-app/analysis/release_quality_report.json
```

`--baseline` に前回リリースのレポートを渡すと、「今回悪化したか」まで機械判定できます。

読む順番:

1. `release_quality_report.md` — 総合判定と FAIL の確認
2. `release_quality_diff.md` — 前回リリース比の悪化
3. `release_quality_summary.csv` — 指標の一覧

品質レポートは `FAIL` 件数だけで判断しないでください。読む順は `OVERALL` → `FAIL` → `PARTIAL` カテゴリ → `MANUAL` → 各カテゴリの親指標 → 派生指標です。自動判定が緑でも、未収集の証跡 (`MANUAL` / `PARTIAL`) が多ければ出荷判定としては弱い状態です (→ [品質レポートの読み方の詳細](quality.md))。

## CI に組み込む

GitLab CI を使っている場合は、[同梱の GitLab CI テンプレート](../ci-templates/gitlab/README.md) を include するだけで、以下の PR ゲートと出荷ゲート (baseline の受け渡し込み) が設定できます。ここでは仕組みを理解するために素のコマンドを示します。

### PR ゲート — 危険な変更だけを止める

```bash
node dist/src/cli.js diff ../frontend \
  --output ./analysis \
  --prefix pr \
  --baseline ../frontend/analysis/baseline_report.json \
  --impact-threshold 50 \
  --fail-on-impact
```

影響度スコアが閾値を超えた変更だけが終了コード `2` で止まります。

### 出荷ゲート — 品質悪化を止める

```bash
node dist/src/cli.js quality gate ../frontend \
  --output ./analysis \
  --prefix release \
  --baseline ../frontend/analysis/release_quality_report.json \
  --quality-gate-monitoring-metrics documentation_presence
```

出荷を止める指標と、悪化を監視するだけの指標を分けられます (→ [baseline 悪化の扱い](quality.md#baseline-悪化の扱いを指標ごとに変える))。

CI では `.ts-analyzer-cache` をキャッシュ対象に入れると 2 回目以降が速くなります。

## よくある失敗と対処

### `diff` が baseline を読めない

原因はほぼ 2 つです。

- `--baseline` のパスが間違っている
- `--output` や `--prefix` を変えたのに、baseline 側のファイル名と一致していない

最も安全な実行例:

```bash
node dist/src/cli.js analyze ./target-app --output ./analysis --prefix baseline
node dist/src/cli.js diff ./target-app --output ./analysis --prefix current \
  --baseline ./target-app/analysis/baseline_report.json
```

### `graph` に `--format html` を付けても HTML が出ない

仕様です。`graph` は JSON と DOT 専用です。HTML で見たい場合は `analyze` を使ってください。

### レポートやログの出力先が想定と違う

相対パスの基準の誤認がほとんどです。`--output ./reports` は「このツールのディレクトリ」ではなく「解析対象の `<projectDir>`」基準で解決されます。

### Unit テスト通過率が MANUAL のまま変わらない

原因は 2 パターンです。

- JUnit XML が出力されていない
- Vitest は検出されているが、実行結果の実績ファイルを収集していない (表示は「Vitest検出 / 結果未収集」)

通過率を自動判定させたい場合は、テスト実行時に JUnit XML を残してください (→ [自動で取り込まれる実績ファイル](quality.md#自動で取り込まれる実績ファイル))。
