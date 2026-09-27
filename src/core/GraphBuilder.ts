import type { CircularDep, DependencyType, EdgeMetadata, GraphEdge, GraphJSON, GraphNode } from "../types/index.js";

interface EdgeRecord {
  // source -> target を構成する依存文の本数
  statementCount: number;
  types: Set<DependencyType>;
  // 依存文がすべて型のみなら true (一つでも実行時依存があれば false)
  isTypeOnly: boolean;
}

export class GraphBuilder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, Map<string, EdgeRecord>>();
  private readonly reverseEdges = new Map<string, Set<string>>();
  private stronglyConnected: string[][] | null = null;
  private weaklyConnected: string[][] | null = null;

  addDependency(source: string, target: string, metadata?: EdgeMetadata): void {
    this.ensureNode(source);
    this.ensureNode(target);

    let targets = this.edges.get(source);
    if (!targets) {
      targets = new Map<string, EdgeRecord>();
      this.edges.set(source, targets);
    }

    const existing = targets.get(target);
    if (existing) {
      // 同じ辺への 2 本目以降の依存文: 種別と本数だけ積み上げる
      existing.statementCount += 1;
      if (metadata?.type) {
        existing.types.add(metadata.type);
      }
      existing.isTypeOnly = existing.isTypeOnly && metadata?.isTypeOnly === true;
      return;
    }

    targets.set(target, {
      statementCount: 1,
      types: new Set<DependencyType>(metadata?.type ? [metadata.type] : []),
      isTypeOnly: metadata?.isTypeOnly === true,
    });
    if (!this.reverseEdges.has(target)) {
      this.reverseEdges.set(target, new Set<string>());
    }
    this.reverseEdges.get(target)?.add(source);

    this.nodes.get(source)!.outDegree = targets.size;
    this.nodes.get(target)!.inDegree = this.reverseEdges.get(target)?.size ?? 0;

    this.stronglyConnected = null;
    this.weaklyConnected = null;
  }

  detectStronglyConnectedComponents(): string[][] {
    if (this.stronglyConnected) {
      return this.stronglyConnected;
    }

    // 数万ノードの深い依存連鎖でも落ちないよう、DFS は反復実装にする
    const visited = new Set<string>();
    const finished: string[] = [];
    const iterativeDfs = (
      start: string,
      neighbors: (node: string) => Iterable<string>,
      onFinish?: (node: string) => void,
      onVisit?: (node: string) => void,
    ): void => {
      const stack: Array<{ node: string; iterator: Iterator<string> }> = [];
      visited.add(start);
      onVisit?.(start);
      stack.push({ node: start, iterator: neighbors(start)[Symbol.iterator]() });
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const next = frame.iterator.next();
        if (next.done) {
          stack.pop();
          onFinish?.(frame.node);
          continue;
        }
        const neighbor = next.value;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          onVisit?.(neighbor);
          stack.push({ node: neighbor, iterator: neighbors(neighbor)[Symbol.iterator]() });
        }
      }
    };

    for (const node of this.nodes.keys()) {
      if (!visited.has(node)) {
        iterativeDfs(node, (id) => this.targetsOf(id), (id) => finished.push(id));
      }
    }

    visited.clear();
    const components: string[][] = [];
    for (let index = finished.length - 1; index >= 0; index -= 1) {
      const node = finished[index];
      if (node && !visited.has(node)) {
        const component: string[] = [];
        iterativeDfs(node, (id) => this.reverseEdges.get(id) ?? [], undefined, (id) => component.push(id));
        components.push(component.sort());
      }
    }

    this.stronglyConnected = components.sort((left, right) => right.length - left.length);
    return this.stronglyConnected;
  }

  detectWeaklyConnectedComponents(): string[][] {
    if (this.weaklyConnected) {
      return this.weaklyConnected;
    }

    const visited = new Set<string>();
    const undirected = new Map<string, Set<string>>();

    for (const node of this.nodes.keys()) {
      undirected.set(node, new Set<string>());
    }
    for (const [source, targets] of this.edges) {
      for (const target of targets.keys()) {
        undirected.get(source)?.add(target);
        undirected.get(target)?.add(source);
      }
    }

    const components: string[][] = [];
    for (const node of this.nodes.keys()) {
      if (visited.has(node)) {
        continue;
      }
      const component: string[] = [];
      const stack = [node];
      visited.add(node);
      while (stack.length > 0) {
        const currentNode = stack.pop()!;
        component.push(currentNode);
        for (const neighbor of undirected.get(currentNode) ?? []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            stack.push(neighbor);
          }
        }
      }
      components.push(component.sort());
    }

    this.weaklyConnected = components.sort((left, right) => right.length - left.length);
    return this.weaklyConnected;
  }

  /**
   * 循環依存を強連結成分 (SCC) 単位で 1 件ずつ返す。
   * 60 ファイルが絡み合った塊も 1 件として数え、その規模は length / affectedFiles / edgeCount で表す。
   */
  detectCycles(): CircularDep[] {
    const sccs = this.detectStronglyConnectedComponents();
    const cycles: CircularDep[] = [];

    for (const component of sccs) {
      if (component.length > 1) {
        cycles.push({
          nodes: component,
          length: component.length,
          severity: this.calculateCycleSeverity(component.length),
          affectedFiles: component.length,
          edgeCount: this.countInternalEdges(component),
        });
        continue;
      }

      const onlyNode = component[0];
      if (onlyNode && this.edges.get(onlyNode)?.has(onlyNode)) {
        cycles.push({
          nodes: [onlyNode, onlyNode],
          length: 1,
          severity: this.calculateCycleSeverity(1),
          affectedFiles: 1,
          edgeCount: 1,
        });
      }
    }

    return cycles;
  }

  calculatePageRank(iterations = 20, dampingFactor = 0.85): Map<string, number> {
    const nodeIds = Array.from(this.nodes.keys());
    const nodeCount = nodeIds.length;
    const initialRank = nodeCount === 0 ? 0 : 1 / nodeCount;
    let current = new Map<string, number>(nodeIds.map((id) => [id, initialRank]));

    const sinkNodes = nodeIds.filter((id) => (this.edges.get(id)?.size ?? 0) === 0);
    const convergenceThreshold = 1e-6 * Math.max(nodeCount, 1);

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const next = new Map<string, number>();
      const sinkContribution = sinkNodes.reduce((sum, id) => sum + (current.get(id) ?? 0), 0);
      let delta = 0;

      for (const node of nodeIds) {
        let rank = (1 - dampingFactor) / Math.max(nodeCount, 1);
        rank += dampingFactor * sinkContribution / Math.max(nodeCount, 1);

        for (const source of this.reverseEdges.get(node) ?? []) {
          const outDegree = this.edges.get(source)?.size ?? 0;
          if (outDegree > 0) {
            rank += dampingFactor * (current.get(source) ?? 0) / outDegree;
          }
        }

        next.set(node, rank);
        delta += Math.abs(rank - (current.get(node) ?? 0));
        this.nodes.get(node)!.pageRank = rank;
      }

      current = next;
      // 収束したら以降のイテレーションを打ち切る
      if (delta < convergenceThreshold) {
        break;
      }
    }

    return current;
  }

  topologicalSort(): string[] | null {
    if (this.detectCycles().length > 0) {
      return null;
    }

    const inDegree = new Map<string, number>(
      Array.from(this.nodes.entries()).map(([id, node]) => [id, node.inDegree]),
    );
    // 隣接リストは一度だけ整列し、同じ入次数 0 の候補は名前順に取り出す (結果を決定的にする)
    const sortedTargets = new Map<string, string[]>();
    for (const [source, targets] of this.edges) {
      sortedTargets.set(source, Array.from(targets.keys()).sort());
    }

    const queue = Array.from(inDegree.entries())
      .filter(([, degree]) => degree === 0)
      .map(([id]) => id)
      .sort();
    const result: string[] = [];

    // queue.shift() は先頭削除が O(V) になるため、読み出し位置だけを進める
    let head = 0;
    while (head < queue.length) {
      const node = queue[head]!;
      head += 1;
      result.push(node);

      const readyTargets: string[] = [];
      for (const target of sortedTargets.get(node) ?? []) {
        const nextDegree = (inDegree.get(target) ?? 0) - 1;
        inDegree.set(target, nextDegree);
        if (nextDegree === 0) {
          readyTargets.push(target);
        }
      }
      // 追加分は整列済み隣接リストの順に並ぶので、そのまま末尾へ
      queue.push(...readyTargets);
    }

    return result.length === this.nodes.size ? result : null;
  }

  exportToJSON(): GraphJSON {
    const edges: GraphEdge[] = [];
    for (const [source, targets] of Array.from(this.edges.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      for (const target of Array.from(targets.keys()).sort()) {
        const record = targets.get(target)!;
        const edge: GraphEdge = {
          source,
          target,
          weight: record.statementCount,
          types: Array.from(record.types).sort(),
        };
        if (record.isTypeOnly) {
          edge.isTypeOnly = true;
        }
        edges.push(edge);
      }
    }

    return {
      nodes: Array.from(this.nodes.values()).sort((left, right) => left.id.localeCompare(right.id)),
      edges,
    };
  }

  exportToDOT(): string {
    let dot = "digraph Dependencies {\n";
    dot += "  rankdir=LR;\n";
    dot += "  node [shape=box style=filled];\n";

    for (const [id, node] of Array.from(this.nodes.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      const label = GraphBuilder.basename(id);
      dot += `  ${GraphBuilder.quoteDot(id)} [label=${GraphBuilder.quoteDot(label)}, fillcolor="${this.getNodeColor(node.inDegree)}"];\n`;
    }

    for (const [source, targets] of Array.from(this.edges.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      for (const target of Array.from(targets.keys()).sort()) {
        dot += `  ${GraphBuilder.quoteDot(source)} -> ${GraphBuilder.quoteDot(target)};\n`;
      }
    }

    dot += "}\n";
    return dot;
  }

  private targetsOf(id: string): Iterable<string> {
    return this.edges.get(id)?.keys() ?? [];
  }

  private countInternalEdges(component: string[]): number {
    const members = new Set(component);
    let count = 0;
    for (const source of component) {
      for (const target of this.targetsOf(source)) {
        if (members.has(target)) {
          count += 1;
        }
      }
    }
    return count;
  }

  private ensureNode(id: string): void {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, inDegree: 0, outDegree: 0, pageRank: 0 });
    }
  }

  /**
   * 循環依存の重大度は絡み合っているファイル数 (SCC の規模) で決める。
   * 2 ファイルの相互参照はどちらか一方の import を切れば解消できるが、
   * 6 ファイル以上の塊は境界を引き直さないと解けないため重い。
   * (docs/glossary.md「循環依存の重大度」と同じ規則)
   */
  private calculateCycleSeverity(length: number): CircularDep["severity"] {
    if (length >= 6) {
      return "critical";
    }
    if (length >= 3) {
      return "high";
    }
    return "medium";
  }

  private getNodeColor(inDegree: number): string {
    if (inDegree > 10) {
      return "#ff6b6b";
    }
    if (inDegree > 5) {
      return "#ffa94d";
    }
    if (inDegree > 2) {
      return "#ffe066";
    }
    return "#8ce99a";
  }

  /** `/` と `\` のどちらの区切りでも最後のパス要素をラベルにする */
  private static basename(id: string): string {
    const segments = id.split(/[\\/]/u).filter((segment) => segment.length > 0);
    return segments[segments.length - 1] ?? id;
  }

  /** Graphviz の二重引用文字列として安全な形にする (`"` `\` と改行をエスケープ) */
  private static quoteDot(value: string): string {
    const escaped = value
      .replace(/\\/gu, "\\\\")
      .replace(/"/gu, "\\\"")
      .replace(/\r/gu, "\\r")
      .replace(/\n/gu, "\\n");
    return `"${escaped}"`;
  }
}
