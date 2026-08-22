import path from "node:path";

import type { AnalysisScope } from "../types/index.js";

export interface FileTypeClassificationOptions {
  componentName?: string;
  hasChildren?: boolean;
}

export interface FileTypePurposeDefinition {
  fileType: string;
  purpose: string;
  directoryHints: string[];
  expectation: string;
}

export const FILE_TYPE_PURPOSES: readonly FileTypePurposeDefinition[] = [
  {
    fileType: "Route",
    purpose: "URL に対応する画面の入口として、画面の組み立てと Feature への振り分けを担う",
    directoryHints: ["app/", "pages/", "page.tsx", "route.ts"],
    expectation: "業務ロジックや重い状態管理を持ち込まず、薄い組み立てに保つ",
  },
  {
    fileType: "Feature",
    purpose: "業務機能単位で、機能固有のロジックと UI をまとめる",
    directoryHints: ["features/", "modules/", "domains/", "scenes/", "containers/"],
    expectation: "機能の境界を越えた相互参照を増やさない",
  },
  {
    fileType: "Layout",
    purpose: "画面の骨格を定義し、ヘッダーやサイドバーの配置とスロットを提供する",
    directoryHints: ["layouts/", "Header / Sidebar / Footer / Shell"],
    expectation: "業務データの取得や業務判断を持たない",
  },
  {
    fileType: "Form",
    purpose: "入力フォームの組み立てと入力状態・送信の制御を担う",
    directoryHints: ["forms/", "components/forms/", "*Form"],
    expectation: "検証ルール自体は Schema / Validation に置き、フォームは利用に徹する",
  },
  {
    fileType: "UI component",
    purpose: "再利用可能な表示部品を提供する",
    directoryHints: ["components/", "components/ui/"],
    expectation: "データ取得や業務判断を持たず、props で受けた値を表示する",
  },
  {
    fileType: "Hook",
    purpose: "状態・副作用ロジックを再利用可能な単位に切り出す",
    directoryHints: ["hooks/", "use* 命名"],
    expectation: "JSX を返す表示責務を持たない",
  },
  {
    fileType: "Context/State",
    purpose: "アプリケーション状態の保持と配布を担う",
    directoryHints: ["contexts/", "*Provider / *Context / *Store"],
    expectation: "状態の持ち主を明確にし、表示ロジックを混ぜない",
  },
  {
    fileType: "API/Infrastructure",
    purpose: "外部 API・永続化などの入出力境界を隔離する",
    directoryHints: ["api/", "services/", "repositories/", "clients/"],
    expectation: "UI・React に依存しない",
  },
  {
    fileType: "Utils",
    purpose: "特定機能に依存しない汎用処理を提供する",
    directoryHints: ["lib/", "utils/", "helpers/"],
    expectation: "React コンポーネントや業務固有ロジックを持たない",
  },
  {
    fileType: "Schema",
    purpose: "データ構造とその制約を宣言的に定義する",
    directoryHints: ["schemas/", "*.schema.*"],
    expectation: "React や画面都合の処理に依存しない",
  },
  {
    fileType: "Validation",
    purpose: "入力検証ルールを一元管理する",
    directoryHints: ["validations/", "validators/", "*.validator.*"],
    expectation: "React や画面都合の処理に依存しない",
  },
  {
    fileType: "Barrel",
    purpose: "再エクスポートで公開 API 面を整理する",
    directoryHints: ["index.ts / index.tsx"],
    expectation: "独自の実装を持たず、再エクスポートに徹する",
  },
  {
    fileType: "Type Support",
    purpose: "型定義・型補助を提供する",
    directoryHints: ["*.d.ts", "shims"],
    expectation: "実行時コードを持たない",
  },
  {
    fileType: "Shared",
    purpose: "まだ責務が確定していない共有コードの一時的な置き場",
    directoryHints: ["(分類規約に一致しないファイル)"],
    expectation: "目的が決まり次第、該当する種別のディレクトリへ移す",
  },
  {
    fileType: "Test",
    purpose: "自動テストで仕様を固定する",
    directoryHints: ["*.test.* / *.spec.*", "__tests__/"],
    expectation: "プロダクトコードから参照されない",
  },
  {
    fileType: "Story",
    purpose: "Storybook ストーリーで UI 状態を記録する",
    directoryHints: ["*.stories.*", "stories/"],
    expectation: "プロダクトコードから参照されない",
  },
  {
    fileType: "Fixture",
    purpose: "テスト・ストーリー用の固定データを提供する",
    directoryHints: ["fixtures/", "__fixtures__/", "*.fixture.*"],
    expectation: "プロダクトコードから参照されない",
  },
  {
    fileType: "Config",
    purpose: "ビルド・ツール設定を保持する",
    directoryHints: ["*.config.*", "tsconfig.json"],
    expectation: "アプリケーションロジックを持たない",
  },
  {
    fileType: "Storybook Support",
    purpose: "Storybook の実行を補助するコードを保持する",
    directoryHints: [".storybook/"],
    expectation: "プロダクトコードから参照されない",
  },
];

export const KNOWN_FILE_TYPES: readonly string[] = FILE_TYPE_PURPOSES.map((definition) => definition.fileType);

const FILE_TYPE_PURPOSE_MAP = new Map(FILE_TYPE_PURPOSES.map((definition) => [definition.fileType, definition]));

export function getFileTypePurpose(fileType: string): FileTypePurposeDefinition | undefined {
  return FILE_TYPE_PURPOSE_MAP.get(fileType);
}

const SOURCE_ONLY_EXCLUDED_FILE_TYPES = new Set([
  "Test",
  "Story",
  "Fixture",
  "Config",
  "Storybook Support",
]);

// 同一パスへの分類はレポート生成中に何度も呼ばれる (実測でファイルあたり約 29 回) ため、
// オプションなしの呼び出しをメモ化する。約 20 本の正規表現評価を 1 回に抑える。
const classificationCache = new Map<string, string>();
const CLASSIFICATION_CACHE_LIMIT = 100_000;

export function classifyFileType(filePath: string, options: FileTypeClassificationOptions = {}): string {
  const cacheable = options.componentName === undefined && options.hasChildren === undefined;
  if (cacheable) {
    const cached = classificationCache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }
  }

  const fileType = computeFileType(filePath, options);
  if (cacheable) {
    if (classificationCache.size >= CLASSIFICATION_CACHE_LIMIT) {
      classificationCache.clear();
    }
    classificationCache.set(filePath, fileType);
  }
  return fileType;
}

function computeFileType(filePath: string, options: FileTypeClassificationOptions): string {
  const normalized = filePath.replace(/\\/gu, "/");
  const lower = normalized.toLowerCase();
  const rawBase = path.basename(normalized);
  const base = rawBase.toLowerCase();
  const rawStem = rawBase.replace(/\.[cm]?[jt]sx?$/u, "");
  const stem = rawStem.toLowerCase();
  const normalizedComponentName = (options.componentName ?? "").toLowerCase();
  const packageSourceSegments = getPackageSourceSegments(normalized);

  const isTestFile = /(?:^|\.)(test|spec)\.[cm]?[jt]sx?$/u.test(base)
    || /(^|\/)(?:__tests__|tests?)(\/|$)/u.test(lower);
  const isStoryFile = /\.stories\.[cm]?[jt]sx?$/u.test(base)
    || /(^|\/)(stories|storybook)\//u.test(lower);
  const isFixtureFile = /(^|\/)(__fixtures__|fixtures)\//u.test(lower)
    || /\.fixture\.[cm]?[jt]sx?$/u.test(base);
  const isStorybookSupportFile = (lower.startsWith(".storybook/") || lower.includes("/.storybook/"))
    && /\.(?:[cm]?[jt]sx?)$/u.test(base)
    && !/^(main|preview|manager|vitest\.setup)\.[cm]?[jt]sx?$/u.test(base);
  const isConfigFile = base === "tsconfig.json"
    || base === "jsconfig.json"
    || base.startsWith("eslint.config.")
    || base.startsWith(".eslintrc")
    || base.startsWith(".prettierrc")
    || base.startsWith("vite.config.")
    || base.startsWith("vitest.config.")
    || base.startsWith("vitest.workspace.")
    || base.startsWith("jest.config.")
    || base.startsWith("storybook.")
    || lower.includes("/.storybook/")
    || lower.startsWith(".storybook/")
    || base.includes(".config.");
  const isBarrelFile = /(^|\/)index\.[cm]?[jt]sx?$/u.test(lower);
  // ベース名による Route 判定は app/・pages/ 配下かソースルート直下のみに限定する。
  // 無条件に適用すると src/lib/error.ts や src/utils/app.ts まで Route になる。
  const isRouteBaseName = /^(app|root|page|loading|error|template|route)\.[cm]?[jt]sx?$/u.test(base);
  const isRouteDirectory = /(^|\/)(app|pages)\//u.test(lower);
  const isSourceRootFile = /^(?:src\/)?[^/]+$/u.test(lower);
  const isRouteFile = isRouteDirectory || (isRouteBaseName && isSourceRootFile);
  const isSchemaFile = /(^|\/)schemas?(\/|$)/u.test(lower)
    || /\.schema\.[cm]?[jt]sx?$/u.test(base);
  const isValidationFile = /(^|\/)(validations?|validators?)(\/|$)/u.test(lower)
    || /\.(validation|validator)\.[cm]?[jt]sx?$/u.test(base);
  const isUiLibraryFile = /(^|\/)components\/ui(\/|$)/u.test(lower)
    || /(^|\/)components\/commons(\/|$)/u.test(lower);
  const isLayoutFile = /(^|\/)(layouts?|layout)(\/|$)/u.test(lower)
    || /(^|\/)(header|sidebar|footer|navbar|layout|shell)\.[cm]?[jt]sx?$/u.test(base)
    || Boolean(options.hasChildren && /(layout|container|shell)$/u.test(normalizedComponentName));
  const isFeatureFile = /(^|\/)(features?|modules?|domains?|scenes?|containers?)(\/|$)/u.test(lower);
  const isHookFile = /^use[A-Z0-9]/u.test(rawStem)
    || /(^|\/)hooks?(\/|$)/u.test(lower);
  const isContextStateFile = /(^|\/)contexts?(\/|$)/u.test(lower)
    || /(provider|context|store)\.[cm]?[jt]sx?$/u.test(base)
    || /(provider|context|store)$/u.test(stem);
  const isApiInfrastructureFile = /(^|\/)(bases\/api|api|services?|repositories?|clients?)(\/|$)/u.test(lower);
  const isUtilsFile = /(^|\/)(lib|utils?|helpers?)(\/|$)/u.test(lower);
  const isTypeSupportFile = /\.d\.[cm]?ts$/u.test(base)
    || base.includes("shims")
    || base.includes("global.d.ts");
  const isFormFile = /(^|\/)(components\/forms?|forms?|form-components)(\/|$)/u.test(lower)
    || stem === "form"
    || stem.endsWith("form")
    || normalizedComponentName.endsWith("form");
  const isPackageSourceUiFile = packageSourceSegments.length > 0 && (
    /^[A-Z]/u.test(rawStem)
    || packageSourceSegments.some((segment, index) => index < packageSourceSegments.length - 1 && /^[A-Z]/u.test(segment))
    || Boolean(options.componentName && /^[A-Z]/u.test(options.componentName))
  );
  const isUiComponentFile = /(^|\/)components(\/|$)/u.test(lower)
    || isPackageSourceUiFile;

  if (isTestFile) {
    return "Test";
  }
  if (isStoryFile) {
    return "Story";
  }
  if (isFixtureFile) {
    return "Fixture";
  }
  if (isStorybookSupportFile) {
    return "Storybook Support";
  }
  if (isConfigFile) {
    return "Config";
  }
  if (isBarrelFile) {
    return "Barrel";
  }
  if (isRouteFile) {
    return "Route";
  }
  if (isSchemaFile) {
    return "Schema";
  }
  if (isValidationFile) {
    return "Validation";
  }
  if (isLayoutFile) {
    if (isUiLibraryFile) {
      return "UI component";
    }
    return "Layout";
  }
  if (isFeatureFile) {
    return "Feature";
  }
  if (isHookFile) {
    return "Hook";
  }
  if (isContextStateFile) {
    return "Context/State";
  }
  if (isApiInfrastructureFile) {
    return "API/Infrastructure";
  }
  if (isUtilsFile) {
    return "Utils";
  }
  if (isTypeSupportFile) {
    return "Type Support";
  }
  if (isUiComponentFile && !isFormFile) {
    return "UI component";
  }
  if (isFormFile) {
    return "Form";
  }
  return "Shared";
}

export function shouldIncludeInAnalysisScope(filePath: string, scope: AnalysisScope): boolean {
  if (scope === "all") {
    return true;
  }

  return !SOURCE_ONLY_EXCLUDED_FILE_TYPES.has(classifyFileType(filePath));
}

function getPackageSourceSegments(filePath: string): string[] {
  const match = /(?:^|\/)packages(?:-internal)?\/[^/]+\/src\/(.+)$/u.exec(filePath);
  return match?.[1]?.split("/") ?? [];
}
