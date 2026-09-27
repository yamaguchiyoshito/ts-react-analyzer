# ts-react-analyzer

English version: [README.en.md](README.en.md)

React / TypeScript プロジェクトの「直すべき場所」を短時間で見つけるための静的解析 CLI です。  
`.ts` / `.tsx` / `.js` / `.jsx` を解析します。

このツールでできること:

- **変更コストの高いファイルが分かる** — 複雑度・依存関係・循環依存を解析し、hot spot を優先度付きで提示します
- **今回の変更で危険になった箇所だけを抽出できる** — baseline 比較で差分を影響度スコア付きで確認でき、CI で危険な変更を自動的に止められます
- **出荷してよいかを機械判定できる** — テスト・アクセシビリティ・セキュリティなど 12 観点の品質レポートと quality gate を出力します
- **ディレクトリの置き場所と実装のズレに気づける** — ディレクトリごとの目的定義と実装内容を突き合わせ、改善提案を提示します

## 必要環境

- Node.js 20 以上 (22 以上を推奨)。20 未満で起動すると理由を表示して終了コード `1` で止まります
- npm または pnpm

## インストール

このリポジトリを clone してビルドします。

```bash
npm install
npm run build
```

以降の例は `node dist/src/cli.js <コマンド>` の形で書いています。`dist/src/cli.js` には shebang が付いているので、コマンドとして登録して `ts-react-analyzer <コマンド>` と打つこともできます。

```bash
# ビルド済みのこのディレクトリをグローバルコマンドとして登録する
npm install -g .
ts-react-analyzer analyze ./my-app

# または、解析対象プロジェクトの devDependencies に入れて npx で呼ぶ
npx ts-react-analyzer analyze .
```

## 5 分で試す

解析したいプロジェクトが `./my-app` にある場合:

```bash
# 0. (任意) 対話形式で設定ファイルを作る
node dist/src/cli.js init ./my-app

# 1. 現状を解析して基準点 (baseline) を作る
node dist/src/cli.js analyze ./my-app

# 2. コードを変更した後、悪化した箇所だけを確認する
#    差分は analysis_diff.*、今回の解析結果は analysis_current_report.* に出力され、
#    baseline (analysis_report.json) は上書きされないので何度でも同じ基準点と比較できます
node dist/src/cli.js diff ./my-app --baseline ./my-app/analysis-reports/analysis_report.json

# 3. 出荷前に品質レポートで審査する
node dist/src/cli.js quality collect ./my-app
node dist/src/cli.js quality gate ./my-app
```

レポートは既定で `<my-app>/analysis-reports/` に出力されます。  
まず `analysis_report.md` を開くと、優先対応 Top 5 と改善提案から読み始められます。`--open` を付けると HTML レポートがブラウザで開きます。

CI などで進行ログ (`[INFO] ...`) が邪魔な場合は `--quiet` (`-q`) を付けてください。結果サマリーと警告・エラーだけが画面に残り、ログファイル (`<my-app>/analysis.log`) には従来どおりすべて記録されます。`-h` でヘルプ、`-v` でバージョンを表示します。

## ドキュメント

| 知りたいこと | ドキュメント |
|---|---|
| 導入手順・毎日の使い方・レポートの読み方・よくある失敗 | [運用ガイド](docs/guide.md) |
| コマンドとオプションの一覧・終了コード | [コマンドリファレンス](docs/commands.md) |
| 出力ファイルと各レポートの内容 | [出力リファレンス](docs/outputs.md) |
| 設定ファイル・環境変数・キャッシュ | [設定リファレンス](docs/configuration.md) |
| File Type 分類とディレクトリ目的・改善提案のルール | [File Type とディレクトリ目的](docs/file-types.md) |
| 品質レポート・quality gate・手動証跡の仕様・指標 ID 一覧 | [品質レポート](docs/quality.md) |
| 表示記号 (○△×・クラスタコード・↗↘) とスケールの定義 | [用語集](docs/glossary.md) |
| GitLab CI への組み込みテンプレート | [ci-templates/gitlab](ci-templates/gitlab/README.md) |
| GitHub Actions への組み込みテンプレート | [ci-templates/github](ci-templates/github/README.md) |

## 開発者向け

このリポジトリ自体を開発する場合のテスト実行:

```bash
npm test
```

テストは path alias 解決、dynamic import、複雑度 / Hooks / `any` 検出、循環依存検出、レポート・graph・diff・quality diff の出力、ディレクトリ目的の監査、キャッシュ再利用、impact 閾値の失敗コードをカバーしています。

## 注意

- Node.js 標準 API を前提にしているため、Node.js 20 未満では動きません (起動時にバージョンを確認して止まります)
- 引数なしで起動するとヘルプを表示して終了コード `1` になります (`--help` は `0`)。終了コードの一覧は [コマンドリファレンス](docs/commands.md#終了コード) を参照してください
- `diff` は baseline に `analyze` が出力した `*_report.json` を要求します。diff 自身の解析結果は `*_current_report.*` に書かれ、baseline は上書きされません
- HTML レポート内の `file://` リンクの開き方は利用環境に依存します
