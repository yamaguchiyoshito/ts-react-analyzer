# ts-react-analyzer

日本語版: [README.md](README.md)

A static-analysis CLI that helps you find "the places worth fixing" in a React / TypeScript project quickly.  
It analyzes `.ts` / `.tsx` / `.js` / `.jsx` files.

What it does:

- **Shows which files are expensive to change** — analyzes complexity, dependencies and circular dependencies, and lists hot spots in priority order
- **Extracts only the parts that became risky in this change** — compares against a baseline, scores each regression by impact, and can stop dangerous changes in CI
- **Decides mechanically whether a build is ready to ship** — produces a 12-aspect quality report (tests, accessibility, security, ...) and a quality gate
- **Spots mismatches between where a file lives and what it does** — checks each directory's stated purpose against its implementation and suggests improvements

## Requirements

- Node.js 20 or later (22 or later recommended). Starting it on Node.js older than 20 prints the reason and exits with code `1`
- npm or pnpm

## Installation

Clone this repository and build it.

```bash
npm install
npm run build
```

The examples below use the form `node dist/src/cli.js <command>`. `dist/src/cli.js` has a shebang, so you can also register it as a command and run `ts-react-analyzer <command>`.

```bash
# Register this built checkout as a global command
npm install -g .
ts-react-analyzer analyze ./my-app

# Or add it to the target project's devDependencies and call it through npx
npx ts-react-analyzer analyze .
```

## Try it in 5 minutes

Assuming the project you want to analyze is in `./my-app`:

```bash
# 0. (optional) Create a config file interactively
node dist/src/cli.js init ./my-app

# 1. Analyze the current state and create a baseline
node dist/src/cli.js analyze ./my-app

# 2. After changing code, look only at what got worse.
#    The diff is written to analysis_diff.*, this run's full analysis to analysis_current_report.*,
#    and the baseline (analysis_report.json) is never overwritten, so you can compare against the
#    same reference point as many times as you like
node dist/src/cli.js diff ./my-app --baseline ./my-app/analysis-reports/analysis_report.json

# 3. Review quality before shipping
node dist/src/cli.js quality collect ./my-app
node dist/src/cli.js quality gate ./my-app
```

Reports are written to `<my-app>/analysis-reports/` by default.  
Open `analysis_report.md` first: it starts with the top 5 files to address and the improvement suggestions. Add `--open` to open the HTML report in your browser.

If the progress log (`[INFO] ...`) gets in the way, for example in CI, add `--quiet` (`-q`). Only the result summary and any warnings or errors stay on screen, while the log file (`<my-app>/analysis.log`) still records everything as before. `-h` prints the help and `-v` prints the version.

## Documentation

The documents below are currently **available in Japanese only**. The table gives an English description of what each one covers so you can find the right page; the command names, option names and report file names in them are the same as in this README.

| What you want to know | Document |
|---|---|
| Setup, day-to-day usage, how to read the reports, common mistakes | [Operations guide](docs/guide.md) (`docs/guide.md`) |
| Every command and option, exit codes | [Command reference](docs/commands.md) (`docs/commands.md`) |
| Output files and what each report contains | [Output reference](docs/outputs.md) (`docs/outputs.md`) |
| Config file, environment variables, cache | [Configuration reference](docs/configuration.md) (`docs/configuration.md`) |
| File Type classification, directory purposes and the rules behind improvement suggestions | [File Types and directory purposes](docs/file-types.md) (`docs/file-types.md`) |
| Quality report, quality gate, manual evidence format, list of metric IDs | [Quality report](docs/quality.md) (`docs/quality.md`) |
| Display symbols (○△×, cluster codes, ↗↘) and scale definitions | [Glossary](docs/glossary.md) (`docs/glossary.md`) |
| GitLab CI integration template | [ci-templates/gitlab](ci-templates/gitlab/README.md) |
| GitHub Actions integration template | [ci-templates/github](ci-templates/github/README.md) |

Quick reference for the most common options (see `docs/commands.md` for the full list):

| Option | Meaning |
|---|---|
| `--output <dir>` | Output directory (relative to `<projectDir>`, default `./analysis-reports`) |
| `--format <formats>` | `csv,markdown,json,html,all` (comma separated) |
| `--prefix <name>` | Output file name prefix (default `analysis`) |
| `--baseline <path>` | `diff` / `quality gate` / `quality diff`: the report to compare against |
| `--impact-threshold <n>` / `--fail-on-impact` | `diff`: exit with code `2` when any file's impact score reaches the threshold |
| `--quiet` / `-q` | Hide `[INFO]` / `[DEBUG]` progress lines on screen (the log file is unaffected) |
| `--verbose` | Log `DEBUG` lines and print stack traces to stderr on failure |
| `--help` / `-h`, `--version` / `-v` | Show help / version and exit with code `0` |

Exit codes: `0` success, `1` execution failure (bad paths or values, no arguments, unknown command or option, Node.js older than 20), `2` failed verdict (`diff` impact threshold exceeded, or `quality gate` FAIL).

## For developers

To run the tests when working on this repository itself:

```bash
npm test
```

The tests cover path alias resolution, dynamic imports, complexity / Hooks / `any` detection, circular dependency detection, report / graph / diff / quality diff output, directory purpose auditing, cache reuse, the impact-threshold failure code, and the CLI behaviour (help, exit codes, `--quiet`).

## Notes

- The tool relies on Node.js standard APIs and does not run on Node.js older than 20 (the version is checked at start-up)
- Running with no arguments prints the help and exits with code `1` (`--help` exits with `0`). See the exit code table in `docs/commands.md`
- `diff` requires a `*_report.json` produced by `analyze` as its baseline. The diff run's own analysis is written to `*_current_report.*`; the baseline is never overwritten
- How `file://` links inside the HTML report open depends on your environment
