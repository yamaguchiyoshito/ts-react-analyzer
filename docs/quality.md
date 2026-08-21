# 品質レポート

`quality` 系コマンドは、出荷審査に使える品質レポートを生成し、出荷可否を機械判定します。  
コマンドの使い方は [コマンドリファレンス](commands.md#quality--出荷前の品質を審査する)、出力ファイルは [出力リファレンス](outputs.md#quality-collect--report--gate-の出力) を参照してください。

## レポートの構成

品質レポートは 12 観点で構成され、観点ごとに複数の指標を持ちます。

- **親指標と派生指標** — gate の判定や件数集計に使われるのは親指標だけです。派生指標 (例: Route / Feature / Form / UI 別のテスト対応率) は原因調査のための診断情報で、総合値 (例: `matching_test_file_presence`) が親指標です
- **自動指標と手動指標** — 実績ファイルから自動判定できる指標は `PASS / WARN / FAIL`、自動化できない指標は `MANUAL` (手動証跡待ち) になります
- **PARTIAL** — 「自動判定はきれいだが、手動証跡が足りず出荷判定を閉じられない」状態です。自動で緑でも `PARTIAL` カテゴリが多ければ、出荷判定としてはまだ弱いと読んでください

## 自動判定される主な内容

- TypeScript 型エラー数、循環依存数、型の逃げ道件数 (`any` / assertion / `ts-ignore` など)
- 対応テストファイル存在率、Unit テスト通過率、LCOV line coverage
- Playwright ベースの E2E 通過率、Storybook Interaction テスト通過率
- axe ベースの WCAG 違反件数、Lighthouse Performance / LCP / TTI
- OpenAPI breaking change 数、MSW 採用シグナル、timeout / retry シグナル
- `npm audit` / Trivy ベースの High / Critical 脆弱性判定
- `dangerouslySetInnerHTML`、機密情報露出パターン、ハードコード JSX 文字列
- CI 設定有無、ドキュメント存在、zod 採用率

## 自動で取り込まれる実績ファイル

テストや監査の実行結果を次の場所に残しておくと、対応する指標が自動判定に変わります。

| 実績ファイル | 使われる指標 |
|---|---|
| `tsconfig.json` | TypeScript 型エラー |
| `coverage/lcov.info` などの LCOV | カバレッジ |
| `junit.xml` / `test-results/*.xml` などの JUnit XML | Unit テスト通過率 |
| `package.json` / `vitest.config.*` / `vitest.workspace.*` | Vitest 検出シグナル |
| `reports/axe*.json` | WCAG 違反件数 |
| `reports/lighthouse*.json` | Lighthouse Performance / LCP / TTI |
| `playwright-report/results.json` | E2E 通過率 |
| `reports/storybook*.json` | Storybook Interaction テスト通過率 |
| `openapi-diff.json` / `reports/openapi-diff.json` | OpenAPI breaking change |
| `npm-audit.json` / `reports/npm-audit.json` | 依存脆弱性 (`npm audit --json` の出力) |
| `trivy.json` / `reports/trivy-results.json` | 依存脆弱性 (Trivy) |

JUnit XML がなく Vitest だけが検出された場合、Unit テスト通過率は「Vitest検出 / 結果未収集」の表示になります。通過率まで自動判定したい場合は JUnit XML を残してください。

## quality gate が失敗する条件

`quality gate` は次のとき終了コード `2` で失敗します。

1. 自動判定 `FAIL` の親指標が 1 件でもある
2. `--baseline` 指定時、親指標の自動判定が前回より悪化した (`pass -> warn` や `warn -> fail`)

### baseline 悪化の扱いを指標ごとに変える

指標 ID 単位で、悪化したときの扱いを選べます。

- `--quality-gate-blocking-metrics <ids>` — ここに入れた指標の悪化で gate を落とします。**空 (未指定) の場合は、すべての自動指標の悪化が gate 対象** です
- `--quality-gate-monitoring-metrics <ids>` — ここに入れた指標は、悪化しても差分レポートに出すだけで gate は落としません
- 両方に同じ指標を入れた場合は monitoring が優先されます

例: ドキュメント整備は悪化しても出荷は止めない、という運用:

```bash
node dist/src/cli.js quality gate ./my-app \
  --baseline ./my-app/reports/release_quality_report.json \
  --quality-gate-monitoring-metrics documentation_presence
```

## quality diff — 前回リリースとの比較

`quality diff` は baseline の `*_quality_report.json` と比較し、悪化・改善・追加・削除された観点を差分化します。  
件数集計に使われるのは親指標だけで、派生指標は診断情報として保持されます。

「悪化」には判定の悪化 (`pass -> warn` など) に加えて、次も含まれます。

- **判定が warn / fail のままの数値悪化** — 例: 型エラー 108 件 → 110 件。「FAIL のまま少しずつ腐る」変化も悪化として数えます
- **証跡の喪失** — 実測できていた指標が manual (証跡待ち) に落ちた場合。改善扱いにはなりません

なお `quality gate --baseline` が終了コード `2` で落とすのは判定の悪化だけです。同一判定内の数値悪化は差分レポートでの可視化に留まります。

## 手動証跡 (quality.manual.json)

要件トレーサビリティや残存バグ数のような自動化できない指標は、`<projectDir>/quality.manual.json` を置くと自動で取り込まれます (`--manual-input` で別パスも指定可能)。

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

## 証跡パスの表記

レポート内の証跡 `filePath` と表示値は、`<projectDir>` 基準の相対パスに正規化されます。レポートをリポジトリ外へ持ち出しても、ローカルの絶対パスは含まれません。
