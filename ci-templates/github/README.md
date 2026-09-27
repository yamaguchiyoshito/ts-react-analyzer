# GitHub Actions テンプレート

ts-react-analyzer を GitHub Actions に組み込むためのテンプレートです。  
`ts-react-analyzer.yml` を `.github/workflows/` にコピーするだけで、次の 3 つのゲートが手に入ります ([GitLab CI テンプレート](../gitlab/README.md) と同じ構成です)。

| ジョブ | いつ動くか | 何をしてくれるか |
|---|---|---|
| `baseline` | デフォルトブランチへの push | 基準点 (baseline) を更新し、artifact として保存します |
| `diff` | pull_request | 今回の変更で影響度スコアが閾値を超えたときだけ PR を失敗させます |
| `quality-gate` | デフォルトブランチへの push・タグ | 品質レポートの `FAIL`、または前回からの品質悪化で失敗させます |

## 使い方

### 1. ワークフローをコピーする

```bash
mkdir -p .github/workflows
cp ci-templates/github/ts-react-analyzer.yml .github/workflows/ts-react-analyzer.yml
```

GitHub Actions は他リポジトリのワークフローを `include` できないため、コピーして使います。

### 2. デフォルトブランチ名を合わせる

テンプレートの `on.push.branches` は `main` になっています。デフォルトブランチが `master` などの場合は書き換えてください。

```yaml
on:
  push:
    branches: [master]
    tags: ["**"]
  pull_request:
```

ジョブ側でも `github.event.repository.default_branch` を確認しているため、他のブランチを足しても baseline が汚れることはありません。

### 3. プロジェクトに合わせて変数を上書きする

ワークフロー先頭の `env:` を編集します。

```yaml
env:
  TSRA_PROJECT_DIR: "frontend"          # 解析したいのがサブディレクトリの場合
  TSRA_IMPACT_THRESHOLD: "50"           # PR ゲートを厳しくする
  TSRA_SETUP_CMD: "npm ci"              # 型エラー数を正しく測りたい場合
  TSRA_QUALITY_MONITORING_METRICS: "documentation_presence"  # ドキュメント整備の悪化では出荷を止めない
  TSRA_REPO_REF: "v0.3.0"               # ツールのバージョンを固定する (タグが無ければコミット SHA)
```

## 変数一覧

| 変数 | 既定値 | 意味 |
|---|---|---|
| `TSRA_PROJECT_DIR` | `.` | 解析対象ディレクトリ (リポジトリルートからの相対パス) |
| `TSRA_OUTPUT_DIR` | `analysis-reports` | レポート出力先 (`TSRA_PROJECT_DIR` 基準) |
| `TSRA_PREFIX` | `ci` | 出力ファイルの接頭辞 |
| `TSRA_IMPACT_THRESHOLD` | `60` | この影響度スコア以上のファイルがあると PR を失敗させる |
| `TSRA_QUALITY_MONITORING_METRICS` | (空) | 悪化しても出荷は止めず監視だけにする品質指標 ID (カンマ区切り) |
| `TSRA_SETUP_CMD` | (空) | 解析前に `TSRA_PROJECT_DIR` で実行するコマンド (例: `npm ci`) |
| `TSRA_NODE_VERSION` | `22` | 実行する Node.js のバージョン (`actions/setup-node`) |
| `TSRA_REPO_URL` | このリポジトリ | ts-react-analyzer の取得元 |
| `TSRA_REPO_REF` | `master` | 取得するブランチ・タグ・コミット SHA。**本番運用ではタグか SHA に固定してください** (`master` は予告なく変わります) |
| `TSRA_BASELINE_ARTIFACT` | `tsra-baseline` | baseline を保存する artifact 名 |

## baseline はどう受け渡されるか

1. デフォルトブランチに push すると `baseline` がレポートを生成し、artifact `tsra-baseline` として 90 日保存します
2. PR の `diff` は、GitHub API (`GET /repos/{owner}/{repo}/actions/artifacts?name=tsra-baseline`) で「デフォルトブランチで作られた、期限切れでない最新の baseline」の run id を探し、`actions/download-artifact` の `run-id` 指定で `*_report.json` を取得して比較します
3. `quality-gate` も同様に、前回の `*_quality_report.json` を取得して悪化を検知します (同じ push で並走している `baseline` ジョブの artifact は除外します)

**初回 (baseline がまだ無いとき) は失敗しません。** 現状解析だけを実行して成功し、デフォルトブランチで `baseline` が一度成功すると次の PR から差分ゲートが有効になります。

別の実行の artifact を取得するため、ワークフローには `permissions: actions: read` が必要です (テンプレートに含まれています)。fork からの PR でも `github.token` は読み取り権限を持つため動作します。

## ゲートに落ちたときの見方

失敗したジョブの artifact (`tsra-diff` / `tsra-quality-gate`) にレポートが入っています。

- PR ゲートに落ちた → `<prefix>_diff.md` で「どのファイルが、どれだけ危険になったか」を確認 (→ [レポートの読み方](../../docs/guide.md#毎日--pr-ごとの使い方--悪化だけを見る))。PR 時点の全体解析は `<prefix>_current_report.md` にあります (baseline の `<prefix>_report.json` は diff では上書きされません)
- 出荷ゲートに落ちた → `<prefix>_quality_report.md` の `FAIL` と、`<prefix>_quality_diff.md` の悪化指標を確認 (→ [品質レポートの読み方](../../docs/quality.md))

## 補足

- 解析キャッシュ (`.ts-analyzer-cache`) は `actions/cache` に載せているため、2 回目以降の実行は速くなります
- TypeScript の型エラー数を品質レポートで正しく測るには、依存パッケージが必要です。`TSRA_SETUP_CMD: "npm ci"` を指定してください (未指定でも他の解析は動きます)
- ログを静かにしたい場合は各 `node "$TSRA_CLI" ...` に `--quiet` を足してください。進行ログ (`[INFO]`) が消え、結果サマリーと警告・エラーだけが残ります
- artifact の保存期間 (`retention-days`) はリポジトリ / Organization の上限を超えられません。上限が 90 日未満の場合は baseline が先に消えるため、値を合わせてください
