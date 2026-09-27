import path from "node:path";
import ts from "typescript";

export interface ResolvedTsConfig {
  // 絶対パスに正規化した tsconfig / jsconfig のパス
  tsConfigPath: string;
  configDir: string;
  parsed: ts.ParsedCommandLine;
  // parsed.fileNames を絶対パスにしたもの。ファイルの所属判定に使う
  fileNameSet: Set<string>;
}

export interface TsConfigResolution {
  // 読み込み自体に失敗した場合は undefined (readError に診断が入る)
  root?: ResolvedTsConfig;
  readError?: ts.Diagnostic;
  // Vite / Next のテンプレートのように、自身はファイルを持たず references だけを列挙する
  // solution スタイルの tsconfig かどうか
  isSolution: boolean;
  // 実際にファイルを持つ末端の設定。solution でなければ root だけが入る
  leaves: ResolvedTsConfig[];
}

export function parseTsConfig(
  tsConfigPath: string,
  existingOptions?: ts.CompilerOptions,
): { config?: ResolvedTsConfig; readError?: ts.Diagnostic } {
  const resolvedTsConfigPath = path.resolve(tsConfigPath);
  const readResult = ts.readConfigFile(resolvedTsConfigPath, ts.sys.readFile);
  if (readResult.error) {
    return { readError: readResult.error };
  }

  const configDir = path.dirname(resolvedTsConfigPath);
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    configDir,
    existingOptions,
    resolvedTsConfigPath,
  );

  return {
    config: {
      tsConfigPath: resolvedTsConfigPath,
      configDir,
      parsed,
      fileNameSet: new Set(parsed.fileNames.map((fileName) => path.resolve(fileName))),
    },
  };
}

export function isSolutionStyleConfig(parsed: ts.ParsedCommandLine): boolean {
  return parsed.fileNames.length === 0
    && Array.isArray(parsed.projectReferences)
    && parsed.projectReferences.length > 0;
}

/**
 * tsconfig を読み、solution スタイル (files が空で references のみ) であれば
 * references を再帰的に辿って末端の設定一覧を返す。循環参照は visited で打ち切る。
 */
export function resolveTsConfigLeaves(
  tsConfigPath: string,
  existingOptions?: ts.CompilerOptions,
): TsConfigResolution {
  const { config: root, readError } = parseTsConfig(tsConfigPath, existingOptions);
  if (!root) {
    return { readError, isSolution: false, leaves: [] };
  }

  if (!isSolutionStyleConfig(root.parsed)) {
    return { root, isSolution: false, leaves: [root] };
  }

  const visited = new Set<string>([root.tsConfigPath]);
  const leaves: ResolvedTsConfig[] = [];
  const collect = (config: ResolvedTsConfig): void => {
    for (const reference of config.parsed.projectReferences ?? []) {
      const referencedPath = path.resolve(ts.resolveProjectReferencePath(reference));
      if (visited.has(referencedPath)) {
        continue;
      }
      visited.add(referencedPath);

      const referenced = parseTsConfig(referencedPath, existingOptions).config;
      if (!referenced) {
        continue;
      }
      if (isSolutionStyleConfig(referenced.parsed)) {
        collect(referenced);
      } else {
        leaves.push(referenced);
      }
    }
  };
  collect(root);

  return { root, isSolution: true, leaves };
}

/** 末端設定のうち、ファイルを持つ最初のものを優先して返す (無ければ先頭)。 */
export function pickPrimaryLeaf(resolution: TsConfigResolution): ResolvedTsConfig | undefined {
  return resolution.leaves.find((leaf) => leaf.parsed.fileNames.length > 0) ?? resolution.leaves[0];
}
