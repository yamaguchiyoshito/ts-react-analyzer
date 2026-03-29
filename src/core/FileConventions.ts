import path from "node:path";

import type { AnalysisScope } from "../types/index.js";

export interface FileTypeClassificationOptions {
  componentName?: string;
  hasChildren?: boolean;
}

const SOURCE_ONLY_EXCLUDED_FILE_TYPES = new Set([
  "Test",
  "Story",
  "Fixture",
  "Config",
  "Storybook Support",
]);

export function classifyFileType(filePath: string, options: FileTypeClassificationOptions = {}): string {
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
  const isRouteFile = /(^|\/)(app|pages)\//u.test(lower)
    || /^(app|root|page|loading|error|template|route)\.[cm]?[jt]sx?$/u.test(base);
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
