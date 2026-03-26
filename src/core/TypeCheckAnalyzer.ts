import path from "node:path";
import ts from "typescript";

export interface TypeCheckIssue {
  filePath: string;
  line: number;
  character: number;
  code: number;
  message: string;
}

export interface TypeCheckSummary {
  totalErrors: number;
  checkedFiles: number;
  issues: TypeCheckIssue[];
  tsConfigPath?: string;
  skippedReason?: string;
}

export class TypeCheckAnalyzer {
  analyzeProject(projectRoot: string, tsConfigPath?: string): TypeCheckSummary {
    if (!tsConfigPath) {
      return {
        totalErrors: 0,
        checkedFiles: 0,
        issues: [],
        skippedReason: "tsconfig.json が見つからないため型検査をスキップしました。",
      };
    }

    const resolvedTsConfigPath = path.resolve(tsConfigPath);
    const readResult = ts.readConfigFile(resolvedTsConfigPath, ts.sys.readFile);
    if (readResult.error) {
      return {
        totalErrors: 1,
        checkedFiles: 0,
        issues: [{
          filePath: resolvedTsConfigPath,
          line: 1,
          character: 1,
          code: readResult.error.code,
          message: ts.flattenDiagnosticMessageText(readResult.error.messageText, "\n"),
        }],
        tsConfigPath: resolvedTsConfigPath,
      };
    }

    const parsed = ts.parseJsonConfigFileContent(
      readResult.config,
      ts.sys,
      path.dirname(resolvedTsConfigPath),
      { noEmit: true },
      resolvedTsConfigPath,
    );

    if (parsed.errors.length > 0) {
      return {
        totalErrors: parsed.errors.length,
        checkedFiles: parsed.fileNames.length,
        issues: parsed.errors.map((diagnostic) => this.toIssue(diagnostic, resolvedTsConfigPath)),
        tsConfigPath: resolvedTsConfigPath,
      };
    }

    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

    return {
      totalErrors: diagnostics.length,
      checkedFiles: parsed.fileNames.filter((fileName) => fileName.startsWith(path.resolve(projectRoot))).length,
      issues: diagnostics.map((diagnostic) => this.toIssue(diagnostic, resolvedTsConfigPath)),
      tsConfigPath: resolvedTsConfigPath,
    };
  }

  private toIssue(diagnostic: ts.Diagnostic, fallbackFilePath: string): TypeCheckIssue {
    const filePath = diagnostic.file?.fileName ? path.resolve(diagnostic.file.fileName) : fallbackFilePath;
    const location = diagnostic.file && typeof diagnostic.start === "number"
      ? ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start)
      : { line: 0, character: 0 };

    return {
      filePath,
      line: location.line + 1,
      character: location.character + 1,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
  }
}
