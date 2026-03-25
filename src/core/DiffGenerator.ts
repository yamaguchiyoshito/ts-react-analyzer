import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AnalysisDiffReport,
  GraphJSON,
  GraphNode,
  HotSpotReportItem,
  PersistedAnalysisReport,
  PersistedFileReport,
} from "../types/index.js";

export class DiffGenerator {
  compare(
    current: PersistedAnalysisReport,
    baseline: PersistedAnalysisReport,
    baselinePath: string,
    currentPath: string,
  ): AnalysisDiffReport {
    const currentFiles = new Map(current.files.map((file) => [file.path, file]));
    const baselineFiles = new Map(baseline.files.map((file) => [file.path, file]));
    const allPaths = Array.from(new Set([...currentFiles.keys(), ...baselineFiles.keys()])).sort();

    const files = allPaths.map((filePath) => this.compareFile(filePath, currentFiles.get(filePath), baselineFiles.get(filePath)));
    const summary = {
      addedFiles: files.filter((file) => file.status === "added").length,
      removedFiles: files.filter((file) => file.status === "removed").length,
      changedFiles: files.filter((file) => file.status === "changed").length,
      unchangedFiles: files.filter((file) => file.status === "unchanged").length,
      complexityDelta: current.statistics.averageComplexity - baseline.statistics.averageComplexity,
      dependencyDelta: current.graph.totalDependencies - baseline.graph.totalDependencies,
    };

    return {
      generatedAt: new Date().toISOString(),
      baselinePath,
      currentPath,
      summary,
      graphDelta: {
        cycleDelta: (current.graph.cycles?.length ?? 0) - (baseline.graph.cycles?.length ?? 0),
        dependencyDelta: current.graph.totalDependencies - baseline.graph.totalDependencies,
        warningDelta: this.diffStrings(current.graph.warnings ?? [], baseline.graph.warnings ?? []),
      },
      hotSpotDelta: this.buildHotSpotDelta(current, baseline),
      impact: this.buildImpactSection(
        files.filter((file) => file.status !== "unchanged").map((file) => file.path),
        current.graphJson,
        baseline.graphJson,
      ),
      files,
    };
  }

  async writeReports(diff: AnalysisDiffReport, outputDir: string, prefix: string): Promise<void> {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, `${prefix}_diff.json`), JSON.stringify(diff, null, 2), "utf8");
    await fs.writeFile(path.join(outputDir, `${prefix}_diff.md`), this.toMarkdown(diff), "utf8");
    await fs.writeFile(path.join(outputDir, `${prefix}_diff.html`), this.toHtml(diff), "utf8");
  }

  private compareFile(pathname: string, current?: PersistedFileReport, baseline?: PersistedFileReport) {
    if (current && !baseline) {
      return {
        path: pathname,
        status: "added" as const,
        complexityDelta: current.complexity.overallComplexity,
        dependencyDelta: current.dependencies.length,
        warningDelta: current.warnings.map((warning) => `+${warning}`),
      };
    }

    if (!current && baseline) {
      return {
        path: pathname,
        status: "removed" as const,
        complexityDelta: -baseline.complexity.overallComplexity,
        dependencyDelta: -baseline.dependencies.length,
        warningDelta: baseline.warnings.map((warning) => `-${warning}`),
      };
    }

    const complexityDelta = (current?.complexity.overallComplexity ?? 0) - (baseline?.complexity.overallComplexity ?? 0);
    const dependencyDelta = (current?.dependencies.length ?? 0) - (baseline?.dependencies.length ?? 0);
    const warningDelta = this.diffStrings(current?.warnings ?? [], baseline?.warnings ?? []);
    const status = complexityDelta !== 0 || dependencyDelta !== 0 || warningDelta.length > 0
      ? "changed" as const
      : "unchanged" as const;

    return {
      path: pathname,
      status,
      complexityDelta,
      dependencyDelta,
      warningDelta,
    };
  }

  private diffStrings(current: string[], baseline: string[]): string[] {
    const currentSet = new Set(current);
    const baselineSet = new Set(baseline);
    const added = current.filter((item) => !baselineSet.has(item)).map((item) => `+${item}`);
    const removed = baseline.filter((item) => !currentSet.has(item)).map((item) => `-${item}`);
    return [...added, ...removed];
  }

  private toMarkdown(diff: AnalysisDiffReport): string {
    const changedFiles = diff.files.filter((file) => file.status !== "unchanged");
    let markdown = "# Analysis Diff Report\n\n";
    markdown += `- Baseline: ${diff.baselinePath}\n`;
    markdown += `- Current: ${diff.currentPath}\n`;
    markdown += `- Generated At: ${diff.generatedAt}\n\n`;

    markdown += "## Summary\n\n";
    markdown += `- Added Files: ${diff.summary.addedFiles}\n`;
    markdown += `- Removed Files: ${diff.summary.removedFiles}\n`;
    markdown += `- Changed Files: ${diff.summary.changedFiles}\n`;
    markdown += `- Unchanged Files: ${diff.summary.unchangedFiles}\n`;
    markdown += `- Average Complexity Delta: ${diff.summary.complexityDelta.toFixed(2)}\n`;
    markdown += `- Dependency Delta: ${diff.summary.dependencyDelta}\n\n`;

    markdown += "## Graph Delta\n\n";
    markdown += `- Cycle Delta: ${diff.graphDelta.cycleDelta}\n`;
    markdown += `- Dependency Delta: ${diff.graphDelta.dependencyDelta}\n`;
    if (diff.graphDelta.warningDelta.length > 0) {
      markdown += diff.graphDelta.warningDelta.map((warning) => `- ${warning}`).join("\n");
      markdown += "\n\n";
    } else {
      markdown += "- Warning Delta: none\n\n";
    }

    markdown += "## Hot Spot Delta\n\n";
    markdown += `- Added Hot Spots: ${diff.hotSpotDelta.added.length}\n`;
    markdown += `- Removed Hot Spots: ${diff.hotSpotDelta.removed.length}\n`;
    markdown += `- Changed Hot Spots: ${diff.hotSpotDelta.changed.length}\n\n`;
    if (diff.hotSpotDelta.changed.length > 0) {
      for (const item of diff.hotSpotDelta.changed.slice(0, 10)) {
        markdown += `- ${item.currentDisplayPath} scoreDelta=${item.scoreDelta} complexityDelta=${item.complexityDelta} dependencyDelta=${item.dependencyDelta} anyDelta=${item.anyDelta} cluster=${item.clusterBefore}->${item.clusterAfter}\n`;
      }
      markdown += "\n";
    }
    if (diff.hotSpotDelta.added.length > 0) {
      markdown += "### Added Hot Spots\n\n";
      for (const item of diff.hotSpotDelta.added.slice(0, 10)) {
        markdown += `- ${item.displayPath} score=${item.score} cluster=${item.cluster}\n`;
      }
      markdown += "\n";
    }

    markdown += "## Changed Subtree\n\n";
    markdown += `- Changed Files: ${diff.impact.changedFiles.length}\n`;
    markdown += `- Impacted Files: ${diff.impact.impactedFiles.length}\n\n`;
    if (diff.impact.prioritizedFiles.length > 0) {
      markdown += "### Prioritized Impacted Files\n\n";
      for (const item of diff.impact.prioritizedFiles.slice(0, 10)) {
        markdown += `- ${item.path} score=${item.score} distance=${item.distance} inbound=${item.inboundDegree} outbound=${item.outboundDegree}\n`;
      }
      markdown += "\n";
    }
    if (diff.impact.impactedFiles.length > 0) {
      markdown += diff.impact.impactedFiles.map((file) => `- ${file}`).join("\n");
      markdown += "\n\n";
    }

    markdown += "## Changed Files\n\n";
    if (changedFiles.length === 0) {
      markdown += "No file-level changes.\n";
      return markdown;
    }

    for (const file of changedFiles) {
      markdown += `- ${file.path} [${file.status}] complexityDelta=${file.complexityDelta} dependencyDelta=${file.dependencyDelta}`;
      if (file.warningDelta.length > 0) {
        markdown += ` warnings=${file.warningDelta.join(",")}`;
      }
      markdown += "\n";
    }

    return markdown;
  }

  private toHtml(diff: AnalysisDiffReport): string {
    const changedSet = new Set(diff.impact.changedFiles);
    const impactedSet = new Set(diff.impact.impactedFiles);
    const rows = diff.files
      .filter((file) => file.status !== "unchanged")
      .map((file) => {
        const warningDelta = file.warningDelta.length > 0 ? file.warningDelta.join(", ") : "";
        return `<tr class="${file.status}"><td><a href="${this.toFileHref(file.path)}">${this.escapeHtml(file.path)}</a></td><td>${file.status}</td><td>${file.complexityDelta}</td><td>${file.dependencyDelta}</td><td>${this.escapeHtml(warningDelta)}</td></tr>`;
      })
      .join("\n");
    const warningDelta = diff.graphDelta.warningDelta.length > 0
      ? diff.graphDelta.warningDelta.map((warning) => `<li>${this.escapeHtml(warning)}</li>`).join("")
      : "<li>none</li>";
    const hotSpotChanged = diff.hotSpotDelta.changed.length > 0
      ? `<ul>${diff.hotSpotDelta.changed.slice(0, 10).map((item) =>
        `<li><a href="${this.toFileHref(item.path)}">${this.escapeHtml(item.currentDisplayPath)}</a> scoreDelta=${item.scoreDelta} complexityDelta=${item.complexityDelta} dependencyDelta=${item.dependencyDelta} anyDelta=${item.anyDelta} cluster=${this.escapeHtml(item.clusterBefore)}-&gt;${this.escapeHtml(item.clusterAfter)}</li>`
      ).join("")}</ul>`
      : "<p>No changed hot spots.</p>";
    const impactGraph = JSON.stringify(diff.impact.graph).replace(/</gu, "\\u003c");
    const subtreeData = JSON.stringify(diff.impact.subtrees).replace(/</gu, "\\u003c");
    const subtreeMetricsData = JSON.stringify(diff.impact.subtrees).replace(/</gu, "\\u003c");
    const prioritizedData = JSON.stringify(diff.impact.prioritizedFiles).replace(/</gu, "\\u003c");
    const focusOptions = [
      `<option value="__all__">All Changed Files</option>`,
      ...diff.impact.subtrees.map((subtree) =>
        `<option value="${this.escapeHtml(subtree.root)}">${this.escapeHtml(subtree.root)}</option>`
      ),
    ].join("");
    const impactedList = diff.impact.impactedFiles.length > 0
      ? `<div id="impact-priority"></div>`
      : "<p>No impacted files.</p>";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Analysis Diff Report</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111827; background: #f8fafc; }
    h1, h2 { margin-bottom: 8px; }
    .meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card { background: white; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
    th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #e2e8f0; }
    tr.added { background: #dcfce7; }
    tr.removed { background: #fee2e2; }
    tr.changed { background: #fef3c7; }
    #impact-shell { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; margin: 20px 0 24px; }
    #impact-graph { min-height: 420px; border: 1px solid #cbd5e1; border-radius: 8px; background: white; overflow: hidden; }
    #impact-list { background: white; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; }
    #impact-toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
    #impact-toolbar select { border: 1px solid #94a3b8; border-radius: 6px; padding: 6px 8px; background: white; }
    #subtree-metrics { margin: 0 0 24px; background: white; border-radius: 8px; overflow: hidden; }
    .impact-entry { border-top: 1px solid #e2e8f0; padding: 10px 0; }
    .impact-entry:first-child { border-top: 0; padding-top: 0; }
    .impact-score { display: inline-block; min-width: 48px; font-weight: 700; color: #0f766e; }
    .impact-meta { color: #475569; font-size: 12px; }
    a { color: #0f766e; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #e2e8f0; border-radius: 4px; padding: 0 4px; }
    ul { margin: 0; padding-left: 18px; }
  </style>
</head>
<body>
  <h1>Analysis Diff Report</h1>
  <div class="meta">
    <div class="card"><strong>Baseline</strong><br /><code>${this.escapeHtml(diff.baselinePath)}</code></div>
    <div class="card"><strong>Current</strong><br /><a href="${this.toFileHref(diff.currentPath)}"><code>${this.escapeHtml(diff.currentPath)}</code></a></div>
    <div class="card"><strong>Generated At</strong><br />${this.escapeHtml(diff.generatedAt)}</div>
    <div class="card"><strong>Changed Files</strong><br />${diff.summary.changedFiles}</div>
    <div class="card"><strong>Added / Removed</strong><br />${diff.summary.addedFiles} / ${diff.summary.removedFiles}</div>
    <div class="card"><strong>Complexity Delta</strong><br />${diff.summary.complexityDelta.toFixed(2)}</div>
    <div class="card"><strong>Changed Hot Spots</strong><br />${diff.hotSpotDelta.changed.length}</div>
  </div>
  <h2>Graph Delta</h2>
  <ul>
    <li>Cycle Delta: ${diff.graphDelta.cycleDelta}</li>
    <li>Dependency Delta: ${diff.graphDelta.dependencyDelta}</li>
    ${warningDelta}
  </ul>
  <h2>Hot Spot Delta</h2>
  <ul>
    <li>Added Hot Spots: ${diff.hotSpotDelta.added.length}</li>
    <li>Removed Hot Spots: ${diff.hotSpotDelta.removed.length}</li>
    <li>Changed Hot Spots: ${diff.hotSpotDelta.changed.length}</li>
  </ul>
  ${hotSpotChanged}
  <h2>Changed Subtree</h2>
  <div id="impact-toolbar">
    <label for="impact-focus">Focus</label>
    <select id="impact-focus">${focusOptions}</select>
    <label for="subtree-sort">Sort subtree by</label>
    <select id="subtree-sort">
      <option value="maxScore">Max Score</option>
      <option value="impactedCount">Impacted Count</option>
      <option value="averageScore">Average Score</option>
      <option value="averageDistance">Average Distance</option>
      <option value="root">Root</option>
    </select>
  </div>
  <table id="subtree-metrics">
    <thead>
      <tr><th>Root</th><th>Impacted</th><th>Max Score</th><th>Average Score</th><th>Average Distance</th><th>Max In</th><th>Max Out</th></tr>
    </thead>
    <tbody id="subtree-metrics-body"></tbody>
  </table>
  <div id="impact-shell">
    <div id="impact-graph"></div>
    <aside id="impact-list">
      <strong>Impacted Files</strong>
      ${impactedList}
    </aside>
  </div>
  <h2>Changed Files</h2>
  <table>
    <thead>
      <tr><th>File</th><th>Status</th><th>Complexity Delta</th><th>Dependency Delta</th><th>Warning Delta</th></tr>
    </thead>
    <tbody>
      ${rows || "<tr><td colspan=\"5\">No changed files.</td></tr>"}
    </tbody>
  </table>
  <script>
    const graphData = ${impactGraph};
    const subtreeData = ${subtreeData};
    const subtreeMetricsData = ${subtreeMetricsData};
    const prioritizedData = ${prioritizedData};
    const changed = new Set(${JSON.stringify(Array.from(changedSet))});
    const impacted = new Set(${JSON.stringify(Array.from(impactedSet))});
    const changedTableRows = Array.from(document.querySelectorAll("tbody tr"));
    const host = document.getElementById("impact-graph");
    const priorityHost = document.getElementById("impact-priority");
    const focusSelect = document.getElementById("impact-focus");
    const subtreeSortSelect = document.getElementById("subtree-sort");
    const subtreeMetricsBody = document.getElementById("subtree-metrics-body");
    const SVG_NS = "http://www.w3.org/2000/svg";
    const subtreeMap = new Map(subtreeData.map((item) => [item.root, item]));

    function renderList(visibleIds) {
      if (!priorityHost) return;
      const visible = prioritizedData
        .filter((item) => visibleIds.has(item.path))
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
      priorityHost.innerHTML = visible.length === 0
        ? "<p>No impacted files.</p>"
        : visible.map((item) => {
            const reasons = item.reasons.join(", ");
            return "<div class=\\"impact-entry\\">" +
              "<div><span class=\\"impact-score\\">" + item.score + "</span><a href=\\"" + toHref(item.path) + "\\">" + item.path + "</a></div>" +
              "<div class=\\"impact-meta\\">distance=" + item.distance + ", inbound=" + item.inboundDegree + ", outbound=" + item.outboundDegree + ", reasons=" + reasons + "</div>" +
            "</div>";
          }).join("");
    }

    function renderGraph(activeGraph) {
      host.innerHTML = "";
      if (!activeGraph.nodes.length) {
        host.innerHTML = "<div style=\\"padding:16px;color:#64748b\\">No impacted graph.</div>";
        return;
      }
      const width = host.clientWidth || 960;
      const height = 420;
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      host.appendChild(svg);

      const centerX = width / 2;
      const centerY = height / 2;
      const radiusBase = Math.min(width, height) * 0.28;
      const nodes = activeGraph.nodes.map((node, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(activeGraph.nodes.length, 1);
        return {
          ...node,
          x: centerX + Math.cos(angle) * (radiusBase + node.outDegree * 8),
          y: centerY + Math.sin(angle) * (radiusBase + node.outDegree * 8),
        };
      });
      const nodeById = Object.fromEntries(nodes.map((node) => [node.id, node]));
      const colorFor = (id) => changed.has(id) ? "#f59e0b" : impacted.has(id) ? "#93c5fd" : "#cbd5e1";

      for (const edge of activeGraph.edges) {
        const source = nodeById[edge.source];
        const target = nodeById[edge.target];
        if (!source || !target) continue;
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", String(source.x));
        line.setAttribute("y1", String(source.y));
        line.setAttribute("x2", String(target.x));
        line.setAttribute("y2", String(target.y));
        line.setAttribute("stroke", "#94a3b8");
        line.setAttribute("stroke-opacity", "0.75");
        svg.appendChild(line);
      }

      for (const node of nodes) {
        const group = document.createElementNS(SVG_NS, "g");
        const circle = document.createElementNS(SVG_NS, "circle");
        const label = document.createElementNS(SVG_NS, "text");
        const title = document.createElementNS(SVG_NS, "title");
        circle.setAttribute("cx", String(node.x));
        circle.setAttribute("cy", String(node.y));
        circle.setAttribute("r", String(changed.has(node.id) ? 11 : 8));
        circle.setAttribute("fill", colorFor(node.id));
        circle.setAttribute("stroke", "#0f172a");
        circle.setAttribute("stroke-width", "0.8");
        label.setAttribute("x", String(node.x + 12));
        label.setAttribute("y", String(node.y + 4));
        label.setAttribute("font-size", "11");
        label.textContent = node.id.split("/").pop();
        title.textContent = node.id;
        circle.appendChild(title);
        group.appendChild(circle);
        group.appendChild(label);
        svg.appendChild(group);
      }
    }

    function toHref(filePath) {
      return "file://" + encodeURI(filePath);
    }

    function renderSubtreeMetrics(sortKey) {
      if (!subtreeMetricsBody) return;
      const items = [...subtreeMetricsData].sort((left, right) => {
        if (sortKey === "root") {
          return left.root.localeCompare(right.root);
        }
        if (sortKey === "averageDistance") {
          return left.metrics.averageDistance - right.metrics.averageDistance || left.root.localeCompare(right.root);
        }
        return right.metrics[sortKey] - left.metrics[sortKey] || left.root.localeCompare(right.root);
      });
      subtreeMetricsBody.innerHTML = items.map((item) =>
        "<tr>" +
          "<td><button type=\\"button\\" data-focus-root=\\"" + item.root + "\\">" + item.root + "</button></td>" +
          "<td>" + item.metrics.impactedCount + "</td>" +
          "<td>" + item.metrics.maxScore + "</td>" +
          "<td>" + item.metrics.averageScore.toFixed(1) + "</td>" +
          "<td>" + item.metrics.averageDistance.toFixed(1) + "</td>" +
          "<td>" + item.metrics.maxInboundDegree + "</td>" +
          "<td>" + item.metrics.maxOutboundDegree + "</td>" +
        "</tr>"
      ).join("");
      for (const button of subtreeMetricsBody.querySelectorAll("button[data-focus-root]")) {
        button.addEventListener("click", (event) => {
          const root = event.currentTarget.getAttribute("data-focus-root");
          if (!root) return;
          if (focusSelect) focusSelect.value = root;
          applyFocus(root);
        });
      }
    }

    function filterChangedTable(visibleIds) {
      for (const row of changedTableRows) {
        const link = row.querySelector("a");
        if (!link) continue;
        const href = link.getAttribute("href") || "";
        const decoded = decodeURI(href.replace(/^file:\/\//, ""));
        row.style.display = visibleIds.has(decoded) ? "" : "none";
      }
    }

    function applyFocus(root) {
      if (root === "__all__") {
        renderGraph(graphData);
        const visibleIds = new Set(graphData.nodes.map((node) => node.id));
        renderList(visibleIds);
        filterChangedTable(visibleIds);
        return;
      }
      const subtree = subtreeMap.get(root);
      if (!subtree) {
        renderGraph(graphData);
        const visibleIds = new Set(graphData.nodes.map((node) => node.id));
        renderList(visibleIds);
        filterChangedTable(visibleIds);
        return;
      }
      renderGraph(subtree.graph);
      const visibleIds = new Set(subtree.impactedFiles);
      renderList(visibleIds);
      filterChangedTable(visibleIds);
    }

    if (focusSelect) {
      focusSelect.addEventListener("change", (event) => {
        applyFocus(event.target.value);
      });
    }
    if (subtreeSortSelect) {
      subtreeSortSelect.addEventListener("change", (event) => {
        renderSubtreeMetrics(event.target.value);
      });
    }
    renderSubtreeMetrics("maxScore");
    applyFocus("__all__");
  </script>
</body>
</html>`;
  }

  private buildImpactSection(
    changedFiles: string[],
    currentGraph?: PersistedAnalysisReport["graphJson"],
    baselineGraph?: PersistedAnalysisReport["graphJson"],
  ) {
    const currentEdges = currentGraph?.edges ?? [];
    const baselineEdges = baselineGraph?.edges ?? [];
    const combinedNodes = this.mergeNodes(currentGraph?.nodes ?? [], baselineGraph?.nodes ?? []);
    const combinedEdges = this.mergeEdges(currentEdges, baselineEdges);
    const adjacency = this.buildUndirectedAdjacency(combinedEdges);
    const incoming = this.buildDirectedAdjacency(combinedEdges, "target");
    const outgoing = this.buildDirectedAdjacency(combinedEdges, "source");

    const subtrees = changedFiles.map((root) => {
      const impactedFiles = this.collectImpactedForRoot(root, adjacency, 2);
      const prioritizedForRoot = impactedFiles.map((filePath) => {
        const distance = this.computeDistanceToChanged(filePath, [root], adjacency);
        const inboundDegree = incoming.get(filePath)?.size ?? 0;
        const outboundDegree = outgoing.get(filePath)?.size ?? 0;
        const directlyChanged = filePath === root;
        const score = this.computeImpactScore({
          directlyChanged,
          distance,
          inboundDegree,
          outboundDegree,
        });
        return { score, distance, inboundDegree, outboundDegree };
      });
      return {
        root,
        impactedFiles,
        metrics: {
          impactedCount: impactedFiles.length,
          maxScore: prioritizedForRoot.reduce((max, item) => Math.max(max, item.score), 0),
          averageScore: prioritizedForRoot.length > 0
            ? prioritizedForRoot.reduce((sum, item) => sum + item.score, 0) / prioritizedForRoot.length
            : 0,
          averageDistance: prioritizedForRoot.length > 0
            ? prioritizedForRoot.reduce((sum, item) => sum + item.distance, 0) / prioritizedForRoot.length
            : 0,
          maxInboundDegree: prioritizedForRoot.reduce((max, item) => Math.max(max, item.inboundDegree), 0),
          maxOutboundDegree: prioritizedForRoot.reduce((max, item) => Math.max(max, item.outboundDegree), 0),
        },
        graph: this.buildGraphSlice(impactedFiles, combinedNodes, combinedEdges),
      };
    });

    const impactedUnion = new Set<string>(changedFiles);
    for (const subtree of subtrees) {
      for (const file of subtree.impactedFiles) {
        impactedUnion.add(file);
      }
    }

    const prioritizedFiles = Array.from(impactedUnion).map((filePath) => {
      const distance = this.computeDistanceToChanged(filePath, changedFiles, adjacency);
      const inboundDegree = incoming.get(filePath)?.size ?? 0;
      const outboundDegree = outgoing.get(filePath)?.size ?? 0;
      const directlyChanged = changedFiles.includes(filePath);
      const score = this.computeImpactScore({
        directlyChanged,
        distance,
        inboundDegree,
        outboundDegree,
      });
      const reasons = this.buildImpactReasons({
        directlyChanged,
        distance,
        inboundDegree,
        outboundDegree,
      });
      return {
        path: filePath,
        score,
        distance,
        inboundDegree,
        outboundDegree,
        directlyChanged,
        reasons,
      };
    }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

    return {
      changedFiles,
      impactedFiles: Array.from(impactedUnion).sort(),
      prioritizedFiles,
      subtrees,
      graph: this.buildGraphSlice(Array.from(impactedUnion), combinedNodes, combinedEdges),
    };
  }

  private buildHotSpotDelta(current: PersistedAnalysisReport, baseline: PersistedAnalysisReport): AnalysisDiffReport["hotSpotDelta"] {
    const currentHotSpots = new Map((current.decisionSummary?.topHotSpots ?? []).map((item) => [item.path, item]));
    const baselineHotSpots = new Map((baseline.decisionSummary?.topHotSpots ?? []).map((item) => [item.path, item]));
    const allPaths = new Set([...currentHotSpots.keys(), ...baselineHotSpots.keys()]);

    const added: HotSpotReportItem[] = [];
    const removed: HotSpotReportItem[] = [];
    const changed: AnalysisDiffReport["hotSpotDelta"]["changed"] = [];

    for (const path of allPaths) {
      const currentItem = currentHotSpots.get(path);
      const baselineItem = baselineHotSpots.get(path);

      if (currentItem && !baselineItem) {
        added.push(currentItem);
        continue;
      }
      if (!currentItem && baselineItem) {
        removed.push(baselineItem);
        continue;
      }
      if (!currentItem || !baselineItem) {
        continue;
      }

      const scoreDelta = currentItem.score - baselineItem.score;
      const complexityDelta = currentItem.complexity - baselineItem.complexity;
      const dependencyDelta = currentItem.dependencies - baselineItem.dependencies;
      const anyDelta = currentItem.anyCount - baselineItem.anyCount;

      if (
        scoreDelta !== 0
        || complexityDelta !== 0
        || dependencyDelta !== 0
        || anyDelta !== 0
        || currentItem.cluster !== baselineItem.cluster
      ) {
        changed.push({
          path,
          currentDisplayPath: currentItem.displayPath,
          baselineDisplayPath: baselineItem.displayPath,
          scoreDelta,
          complexityDelta,
          dependencyDelta,
          anyDelta,
          clusterBefore: baselineItem.cluster,
          clusterAfter: currentItem.cluster,
        });
      }
    }

    added.sort((left, right) => right.score - left.score || left.displayPath.localeCompare(right.displayPath));
    removed.sort((left, right) => right.score - left.score || left.displayPath.localeCompare(right.displayPath));
    changed.sort((left, right) => Math.abs(right.scoreDelta) - Math.abs(left.scoreDelta) || left.currentDisplayPath.localeCompare(right.currentDisplayPath));

    return { added, removed, changed };
  }

  private mergeNodes(currentNodes: GraphNode[], baselineNodes: GraphNode[]): GraphNode[] {
    const byId = new Map<string, GraphNode>();
    for (const node of [...baselineNodes, ...currentNodes]) {
      const existing = byId.get(node.id);
      if (!existing) {
        byId.set(node.id, { ...node });
        continue;
      }
      byId.set(node.id, {
        id: node.id,
        inDegree: Math.max(existing.inDegree, node.inDegree),
        outDegree: Math.max(existing.outDegree, node.outDegree),
        pageRank: Math.max(existing.pageRank, node.pageRank),
      });
    }
    return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
  }

  private mergeEdges(currentEdges: GraphJSON["edges"], baselineEdges: GraphJSON["edges"]): GraphJSON["edges"] {
    const merged = new Map<string, GraphJSON["edges"][number]>();
    for (const edge of [...baselineEdges, ...currentEdges]) {
      merged.set(`${edge.source}=>${edge.target}`, edge);
    }
    return Array.from(merged.values()).sort((left, right) =>
      left.source.localeCompare(right.source) || left.target.localeCompare(right.target)
    );
  }

  private buildUndirectedAdjacency(edges: GraphJSON["edges"]): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!adjacency.has(edge.source)) {
        adjacency.set(edge.source, new Set<string>());
      }
      if (!adjacency.has(edge.target)) {
        adjacency.set(edge.target, new Set<string>());
      }
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    }
    return adjacency;
  }

  private buildDirectedAdjacency(
    edges: GraphJSON["edges"],
    direction: "source" | "target",
  ): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      const key = direction === "source" ? edge.source : edge.target;
      const value = direction === "source" ? edge.target : edge.source;
      if (!adjacency.has(key)) {
        adjacency.set(key, new Set<string>());
      }
      adjacency.get(key)?.add(value);
    }
    return adjacency;
  }

  private collectImpactedForRoot(root: string, adjacency: Map<string, Set<string>>, maxDepth: number): string[] {
    const visited = new Set<string>([root]);
    const queue: Array<{ node: string; depth: number }> = [{ node: root, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      if (current.depth >= maxDepth) {
        continue;
      }
      for (const next of adjacency.get(current.node) ?? []) {
        if (visited.has(next)) {
          continue;
        }
        visited.add(next);
        queue.push({ node: next, depth: current.depth + 1 });
      }
    }

    return Array.from(visited).sort();
  }

  private buildGraphSlice(nodeIds: string[], nodes: GraphNode[], edges: GraphJSON["edges"]): GraphJSON {
    const allowed = new Set(nodeIds);
    return {
      nodes: nodes.filter((node) => allowed.has(node.id)),
      edges: edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)),
    };
  }

  private computeDistanceToChanged(
    path: string,
    changedFiles: string[],
    adjacency: Map<string, Set<string>>,
  ): number {
    if (changedFiles.includes(path)) {
      return 0;
    }

    const visited = new Set<string>(changedFiles);
    const queue = changedFiles.map((file) => ({ file, distance: 0 }));
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      for (const next of adjacency.get(current.file) ?? []) {
        if (visited.has(next)) {
          continue;
        }
        if (next === path) {
          return current.distance + 1;
        }
        visited.add(next);
        queue.push({ file: next, distance: current.distance + 1 });
      }
    }
    return 99;
  }

  private computeImpactScore(input: {
    directlyChanged: boolean;
    distance: number;
    inboundDegree: number;
    outboundDegree: number;
  }): number {
    let score = 0;
    if (input.directlyChanged) {
      score += 100;
    }
    score += Math.max(0, 50 - input.distance * 12);
    score += input.inboundDegree * 5;
    score += input.outboundDegree * 4;
    return score;
  }

  private buildImpactReasons(input: {
    directlyChanged: boolean;
    distance: number;
    inboundDegree: number;
    outboundDegree: number;
  }): string[] {
    const reasons: string[] = [];
    if (input.directlyChanged) {
      reasons.push("changed");
    }
    if (input.distance <= 1 && !input.directlyChanged) {
      reasons.push("adjacent-to-change");
    } else if (input.distance <= 2) {
      reasons.push("within-2-hops");
    }
    if (input.inboundDegree >= 2) {
      reasons.push("high-fan-in");
    }
    if (input.outboundDegree >= 2) {
      reasons.push("high-fan-out");
    }
    return reasons;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;")
      .replace(/"/gu, "&quot;");
  }

  private toFileHref(filePath: string): string {
    return pathToFileURL(filePath).href;
  }
}
