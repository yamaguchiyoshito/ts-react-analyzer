# GitLab CI テンプレート

ts-react-analyzer を GitLab CI に組み込むためのテンプレートです。  
コピーして `include` するだけで、次の 3 つのゲートが手に入ります。

| ジョブ | いつ動くか | 何をしてくれるか |
|---|---|---|
| `tsra:baseline` | デフォルトブランチへの push | 基準点 (baseline) を更新し、以後の比較元として保存します |
| `tsra:diff` | Merge Request | 今回の変更で影響度スコアが閾値を超えたときだけ MR を失敗させます |
| `tsra:quality-gate` | デフォルトブランチへの push・タグ | 品質レポートの `FAIL`、または前回からの品質悪化で失敗させます |

## 使い方

### 1. テンプレートを自分のリポジトリに置いて include する (推奨)

`ts-react-analyzer.gitlab-ci.yml` を自分のリポジトリ (例: `ci/` 配下) へコピーし、`.gitlab-ci.yml` から読み込みます。

```yaml
include:
  - local: "ci/ts-react-analyzer.gitlab-ci.yml"
```

### 2. リモート参照で include する

コピーせずに参照することもできます (GitLab Runner から GitHub へアクセスできる場合)。

```yaml
include:
  - remote: "https://raw.githubusercontent.com/yamaguchiyoshito/ts-react-analyzer/master/ci-templates/gitlab/ts-react-analyzer.gitlab-ci.yml"
```

### 3. プロジェクトに合わせて変数を上書きする

```yaml
include:
  - local: "ci/ts-react-analyzer.gitlab-ci.yml"

variables:
  TSRA_PROJECT_DIR: "frontend"          # 解析したいのがサブディレクトリの場合
  TSRA_IMPACT_THRESHOLD: "50"           # MR ゲートを厳しくする
  TSRA_SETUP_CMD: "npm ci"              # 型エラー数を正しく測りたい場合
  TSRA_QUALITY_MONITORING_METRICS: "documentation_presence"  # ドキュメント整備の悪化では出荷を止めない
```

## 変数一覧

| 変数 | 既定値 | 意味 |
|---|---|---|
| `TSRA_PROJECT_DIR` | `.` | 解析対象ディレクトリ (リポジトリルートからの相対パス) |
| `TSRA_OUTPUT_DIR` | `analysis-reports` | レポート出力先 (`TSRA_PROJECT_DIR` 基準) |
| `TSRA_PREFIX` | `ci` | 出力ファイルの接頭辞 |
| `TSRA_IMPACT_THRESHOLD` | `60` | この影響度スコア以上のファイルがあると MR を失敗させる |
| `TSRA_QUALITY_MONITORING_METRICS` | (空) | 悪化しても出荷は止めず監視だけにする品質指標 ID (カンマ区切り) |
| `TSRA_SETUP_CMD` | (空) | 解析前に `TSRA_PROJECT_DIR` で実行するコマンド (例: `npm ci`) |
| `TSRA_NODE_IMAGE` | `node:22` | ジョブの実行イメージ |
| `TSRA_REPO_URL` | このリポジトリ | ts-react-analyzer の取得元 |
| `TSRA_REPO_REF` | `master` | 取得するブランチまたはタグ |

## baseline はどう受け渡されるか

1. デフォルトブランチに push すると `tsra:baseline` がレポートを生成し、ジョブ成果物 (artifacts) として 90 日保存します
2. MR の `tsra:diff` は、ターゲットブランチの最新 `tsra:baseline` 成果物から `*_report.json` を取得して比較します
3. `tsra:quality-gate` も同様に、前回の `*_quality_report.json` を取得して悪化を検知します

**初回 (baseline がまだ無いとき) は失敗しません。** 現状解析だけを実行して成功し、デフォルトブランチで `tsra:baseline` が一度成功すると次の MR から差分ゲートが有効になります。

## ゲートに落ちたときの見方

失敗したジョブの成果物 (artifacts) にレポートが入っています。

- MR ゲートに落ちた → `<prefix>_diff.md` で「どのファイルが、どれだけ危険になったか」を確認 (→ [レポートの読み方](../../docs/guide.md#毎日--pr-ごとの使い方--悪化だけを見る))
- 出荷ゲートに落ちた → `<prefix>_quality_report.md` の `FAIL` と、`<prefix>_quality_diff.md` の悪化指標を確認 (→ [品質レポートの読み方](../../docs/quality.md))

## 補足

- 解析キャッシュ (`.ts-analyzer-cache`) は GitLab の cache に載せているため、2 回目以降の実行は速くなります
- TypeScript の型エラー数を品質レポートで正しく測るには、依存パッケージが必要です。`TSRA_SETUP_CMD: "npm ci"` を指定してください (未指定でも他の解析は動きます)
- ジョブは既定の `test` ステージで動きます。ステージを分けたい場合は同名ジョブを定義して `stage:` を上書きしてください
