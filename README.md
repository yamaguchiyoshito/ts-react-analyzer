# ts-react-analyzer

React / TypeScript プロジェクトの「直すべき場所」を短時間で見つけるための静的解析 CLI です。  
`.ts` / `.tsx` / `.js` / `.jsx` を解析します。

このツールでできること:

- **変更コストの高いファイルが分かる** — 複雑度・依存関係・循環依存を解析し、hot spot を優先度付きで提示します
- **今回の変更で危険になった箇所だけを抽出できる** — baseline 比較で差分を影響度スコア付きで確認でき、CI で危険な変更を自動的に止められます
- **出荷してよいかを機械判定できる** — テスト・アクセシビリティ・セキュリティなど 12 観点の品質レポートと quality gate を出力します
- **ディレクトリの置き場所と実装のズレに気づける** — ディレクトリごとの目的定義と実装内容を突き合わせ、改善提案を提示します

## 必要環境

- Node.js 22 以上を推奨
- npm または pnpm

## インストール

```bash
npm install
npm run build
```

## 5 分で試す

解析したいプロジェクトが `./my-app` にある場合:

```bash
# 1. 現状を解析して基準点 (baseline) を作る
node dist/src/cli.js analyze ./my-app

# 2. コードを変更した後、悪化した箇所だけを確認する
node dist/src/cli.js diff ./my-app --baseline ./my-app/analysis-reports/analysis_report.json

# 3. 出荷前に品質レポートで審査する
node dist/src/cli.js quality collect ./my-app
node dist/src/cli.js quality gate ./my-app
```

レポートは既定で `<my-app>/analysis-reports/` に出力されます。  
まず `analysis_report.md` を開くと、優先対応 Top 5 と改善提案から読み始められます。

## ドキュメント

| 知りたいこと | ドキュメント |
|---|---|
| 導入手順・毎日の使い方・レポートの読み方・よくある失敗 | [運用ガイド](docs/guide.md) |
| コマンドとオプションの一覧・終了コード | [コマンドリファレンス](docs/commands.md) |
| 出力ファイルと各レポートの内容 | [出力リファレンス](docs/outputs.md) |
| 設定ファイル・環境変数・キャッシュ | [設定リファレンス](docs/configuration.md) |
| File Type 分類とディレクトリ目的・改善提案のルール | [File Type とディレクトリ目的](docs/file-types.md) |
| 品質レポート・quality gate・手動証跡の仕様 | [品質レポート](docs/quality.md) |
| GitLab CI への組み込みテンプレート | [ci-templates/gitlab](ci-templates/gitlab/README.md) |

## 開発者向け

このリポジトリ自体を開発する場合のテスト実行:

```bash
npm test
```

テストは path alias 解決、dynamic import、複雑度 / Hooks / `any` 検出、循環依存検出、レポート・graph・diff・quality diff の出力、ディレクトリ目的の監査、キャッシュ再利用、impact 閾値の失敗コードをカバーしています。

## 注意

- Node.js 標準 API を前提にしているため、古い Node では動きません
- `diff` は baseline に `analyze` が出力した `*_report.json` を要求します
- HTML レポート内の `file://` リンクの開き方は利用環境に依存します
