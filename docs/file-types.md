# File Type とディレクトリ目的

`analyze` は各ファイルを配置ディレクトリ・ファイル名・拡張子・周辺文脈から **File Type** に分類します。  
`<prefix>_files.csv` や `<prefix>_components.csv` の `File Type` 列、レポートの「ファイル種別分布」で確認できます。

さらに各 File Type には「そのディレクトリが果たすべき目的」を定義しており、目的と実装内容が食い違うファイルには改善提案が出ます。

## File Type 一覧と目的

| File Type | このディレクトリの目的 | 主な配置 |
|---|---|---|
| `Route` | URL に対応する画面の入口。画面の組み立てと Feature への振り分け | `app/`, `pages/`, `page.tsx` |
| `Feature` | 業務機能単位のロジックと機能固有 UI | `features/`, `modules/`, `domains/` |
| `Layout` | 画面の骨格とスロット提供 | `layouts/`, `Header` / `Sidebar` など |
| `Form` | 入力フォームの組み立てと入力状態・送信の制御 | `forms/`, `*Form` |
| `UI component` | 再利用可能な表示部品。データ取得や業務判断を持たない | `components/`, `components/ui/` |
| `Hook` | 状態・副作用ロジックの再利用単位。JSX を持たない | `hooks/`, `use*` |
| `Context/State` | アプリ状態の保持と配布 | `contexts/`, `*Provider` / `*Store` |
| `API/Infrastructure` | 外部 API・永続化などの入出力境界。UI を知らない | `api/`, `services/`, `repositories/` |
| `Utils` | 特定機能に依存しない汎用処理 | `lib/`, `utils/`, `helpers/` |
| `Schema` | データ構造と制約の宣言的定義 | `schemas/`, `*.schema.*` |
| `Validation` | 入力検証ルールの一元管理 | `validations/`, `*.validator.*` |
| `Barrel` | 再エクスポートによる公開 API 面の整理 | `index.ts` |
| `Type Support` | 型定義・型補助。実行時コードを持たない | `*.d.ts`, `shims` |
| `Shared` | 責務未確定の共有コードの一時的な置き場 | 分類規約に一致しないファイル |
| `Test` | 自動テスト | `*.test.*`, `__tests__/` |
| `Story` | Storybook ストーリー | `*.stories.*` |
| `Fixture` | テスト用固定データ | `fixtures/`, `*.fixture.*` |
| `Config` | ビルド・ツール設定 | `*.config.*`, `tsconfig.json` |
| `Storybook Support` | Storybook 実行補助 | `.storybook/` |

例として `components/ui/**` は `UI component`、`schemas/**` は `Schema`、`validations/**` は `Validation`、`*.d.ts` は `Type Support` に分類されます。

`Shared` は「どの規約にも一致しなかった」ことを示す分類です。`Shared` が多い場合は、ディレクトリ構成が規約に沿っていないか、責務の置き場所が決まっていないかのどちらかです。

## ディレクトリ目的の整合チェック

`analyze` は上記の目的定義と実装内容を突き合わせ、食い違うファイルに改善提案を出します。  
結果は `<prefix>_report.md` の「ディレクトリ目的と改善提案」セクションと、`<prefix>_report.json` の `directoryPurposeAudit` で確認できます。

検出される不整合と、提案される改善:

| 検出される状態 | severity | 提案される改善 |
|---|---|---|
| `Utils` / `API/Infrastructure` に React コンポーネントが定義されている | high | コンポーネントを `components/` や `features/` へ移し、この層は表示を持たない処理に限定する |
| `Schema` / `Validation` が React に依存している | high | React 依存を取り除き、画面都合の処理は Hook / Form 側へ移す |
| `Barrel` (index) に再エクスポート以外の実装がある | medium | 実装を個別ファイルへ移し、index は再エクスポート専用に保つ |
| `Type Support` に実行時コードがある | medium | 実行時コードを通常のモジュールへ移す |
| `UI component` / `Layout` が `API/Infrastructure` を直接参照している | medium | データ取得は Hook / Feature 側へ寄せ、UI は props で値を受け取る |
| `Route` の複雑度が 12 以上に育っている | medium | 画面の組み立て以外のロジックを Feature / Hook へ抽出する |
| `Hook` ファイルに React コンポーネントが定義されている | medium | 表示はコンポーネントへ分離し、Hook はロジック専用に保つ |
| `Shared` のままコード行数 40 以上または複雑度 8 以上に成長している | low | 目的の明確なディレクトリへ移し、責務を確定する |

対応は severity の高いものから進めてください。  
Markdown レポートには severity 順に最大 20 件が表示され、全件は JSON の `directoryPurposeAudit` に入っています。
