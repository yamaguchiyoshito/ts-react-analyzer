import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

import { ComplexityAnalyzer } from "../src/core/index.js";
import type { FileComplexityAnalysis } from "../src/types/index.js";

function analyze(source: string, fileName = "Sample.tsx"): FileComplexityAnalysis {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  return new ComplexityAnalyzer().analyzeFile(sourceFile, `/virtual/${fileName}`);
}

function componentNames(metrics: FileComplexityAnalysis): string[] {
  return metrics.components.map((component) => component.name);
}

test("ComplexityAnalyzer detects class components and reads props from the heritage type argument", () => {
  const metrics = analyze(`
    import React, { Component, PureComponent } from "react";

    interface CounterProps { initial: number; label?: string }

    class Counter extends React.Component<CounterProps, { count: number }> {
      render() {
        return <div>{this.props.label}<span>{this.state.count}</span></div>;
      }
    }

    class Plain extends PureComponent {
      render() { return <p>plain</p>; }
    }

    class Inline extends Component<{ id: string; onSelect?: () => void }> {
      render() { return <li>{this.props.id}</li>; }
    }

    // render() があっても React の基底クラスを継承していなければコンポーネントではない
    class NotAComponent {
      render() { return <div />; }
    }
    class Service extends BaseService {
      run() { return 1; }
    }
  `);

  assert.deepEqual(componentNames(metrics), ["Counter", "Plain", "Inline"]);

  const counter = metrics.components[0]!;
  assert.equal(counter.jsxElements, 2);
  assert.equal(counter.propsInterface?.name, "CounterProps");
  assert.deepEqual(
    counter.propsInterface?.properties.map((property) => `${property.name}${property.required ? "" : "?"}`),
    ["initial", "label?"],
  );

  assert.equal(metrics.components[1]?.propsInterface, null);

  const inline = metrics.components[2]!;
  assert.deepEqual(inline.propsInterface?.properties.map((property) => property.name), ["id", "onSelect"]);
});

test("ComplexityAnalyzer reads props from React.FC / FC type annotations", () => {
  const metrics = analyze(`
    import type { FC } from "react";

    type CardProps = { title: string; onClose?: () => void };

    export const Card: React.FC<CardProps> = ({ title, onClose }) => (
      <section onClick={onClose}>{title}</section>
    );
    export const Chip: FC<{ text: string }> = ({ text }) => <span>{text}</span>;
    export const Silent: React.FunctionComponent<CardProps> = () => null;
  `);

  assert.deepEqual(componentNames(metrics), ["Card", "Chip", "Silent"]);

  const card = metrics.components[0]!;
  assert.equal(card.propsInterface?.name, "CardProps");
  assert.equal(card.propsInterface?.typeDeclaration, "CardProps");
  assert.deepEqual(
    card.propsInterface?.properties.map((property) => [property.name, property.required, property.type]),
    [["title", true, "string"], ["onClose", false, "() => void"]],
  );

  const chip = metrics.components[1]!;
  assert.deepEqual(chip.propsInterface?.properties.map((property) => property.name), ["text"]);
});

test("ComplexityAnalyzer reads props from forwardRef and memo type arguments", () => {
  const metrics = analyze(`
    import React, { forwardRef, memo } from "react";

    interface BaseProps { id: string }
    interface InputProps extends BaseProps { value: string; disabled?: boolean }

    export const Input = forwardRef<HTMLInputElement, InputProps>((props, ref) => (
      <input ref={ref} value={props.value} />
    ));
    export const Memoized = memo<InputProps>((props) => <input value={props.value} />);
    export const Nested = React.memo(
      React.forwardRef<HTMLDivElement, InputProps>(function Inner(props, ref) {
        return <div ref={ref} />;
      }),
    );
    // 既存コンポーネントをラップしただけの memo(Card) は新しいコンポーネントとして数えない
    const Plain = memo(Input);
  `);

  assert.deepEqual(componentNames(metrics), ["Input", "Memoized", "Nested"]);

  for (const component of metrics.components) {
    assert.equal(component.propsInterface?.name, "InputProps", component.name);
    // 同一ファイル内の interface 継承 (extends BaseProps) も辿る
    assert.deepEqual(
      component.propsInterface?.properties.map((property) => property.name).sort(),
      ["disabled", "id", "value"],
      component.name,
    );
  }
  assert.equal(metrics.components[0]?.isForwardRef, true);
  assert.equal(metrics.components[1]?.isForwardRef, false);
  assert.equal(metrics.components[2]?.isForwardRef, true);
});

test("ComplexityAnalyzer does not treat PascalCase JSX values as components", () => {
  const metrics = analyze(`
    const Template = <Card title="x" />;
    const Routes = [<A key="a" />, <B key="b" />];
    const Config = { icon: <Icon /> };
    const Lazy = React.lazy(() => import("./Heavy"));
    export const List = () => <ul>{Routes}</ul>;
  `);

  assert.deepEqual(componentNames(metrics), ["List"]);
});

test("ComplexityAnalyzer detects anonymous default export components", () => {
  const page = analyze("export default function () { return <main /> }", "Page.tsx");
  assert.deepEqual(componentNames(page), ["Page"]);
  assert.equal(page.functions[0]?.name, "default");

  const index = analyze("export default () => <div />", "index.tsx");
  assert.deepEqual(componentNames(index), ["default"]);

  const hero = analyze("export default memo(function Hero() { return <h1 /> })", "Hero.tsx");
  assert.deepEqual(componentNames(hero), ["Hero"]);

  // 名前付き関数の default export はこれまでどおり関数名で 1 回だけ数える
  const named = analyze("export default function About() { return <p /> }", "about.tsx");
  assert.deepEqual(componentNames(named), ["About"]);

  // 変数を default export しても二重に数えない
  const reexported = analyze("const Home = () => <div />;\nexport default Home;", "Home.tsx");
  assert.deepEqual(componentNames(reexported), ["Home"]);
});

test("ComplexityAnalyzer keeps as const out of assertion counts and unwraps parenthesised double assertions", () => {
  const metrics = analyze(`
    const stable = { a: 1 } as const;
    const tuple = [1, 2] as const;
    const converted = (value as any) as Foo;
    const paren = value as (any);
    const commented = value as any /* legacy */;
    const angled = <Foo>(<any>value);
  `, "asserts.ts");

  const { typeMetrics } = metrics;
  assert.equal(typeMetrics.constAssertionCount, 2);
  // as const 2 件は assertionCount に含めない: 残りの 6 ノードだけ
  assert.equal(typeMetrics.assertionCount, 6);
  assert.equal(typeMetrics.doubleAssertionCount, 2);
  assert.equal(typeMetrics.unsafeAssertionCount, 6);
  assert.ok(!typeMetrics.uncheckedPatterns.includes("type-assertion:const"));
  assert.equal(typeMetrics.uncheckedPatterns.filter((pattern) => pattern === "double-assertion").length, 2);
  // any を対象にしたノードは 4 つ。ネストした外側の `as Foo` で二重計上しない
  assert.equal(typeMetrics.uncheckedPatterns.filter((pattern) => pattern === "type-assertion:any").length, 4);
});

test("ComplexityAnalyzer recognises use() and reports dependency arrays per hook kind", () => {
  const metrics = analyze(`
    function Profile({ promise }) {
      const user = use(promise);
      const theme = React.use(ThemeContext);
      const [n, setN] = useState(0);
      const [state, dispatch] = useReducer(reducer, initialState);
      const ref = useRef(null);
      const ctx = useContext(Ctx);
      const deps = [n];
      useEffect(() => {}, [n]);
      useEffect(() => {}, deps);
      useEffect(() => {});
      const doubled = useMemo(() => n * 2, [n]);
      const cb = useCallback(() => {}, deps);
      useLayoutEffect(() => {}, []);
      useImperativeHandle(ref, () => ({}), [n]);
      const custom = useCustom(n, [n]);
      app.use(middleware);
      return <div />;
    }
  `);

  const summary = metrics.hooks.map((hook) => `${hook.name}:${hook.hasDependencies}`);
  assert.deepEqual(summary, [
    "use:false",
    "use:false",
    "useState:false",
    "useReducer:false",
    "useRef:false",
    "useContext:false",
    "useEffect:true",
    "useEffect:true",
    "useEffect:false",
    "useMemo:true",
    "useCallback:true",
    "useLayoutEffect:true",
    "useImperativeHandle:true",
    "useCustom:true",
  ]);
  assert.equal(metrics.components[0]?.hookCount, 14);
});

test("ComplexityAnalyzer names function expressions after their binding", () => {
  const metrics = analyze(`
    const handler = function () { return 1; };
    const options = { onClick: () => {}, onHover() {}, onKey: function () {} };
    class Widget { handleClick = () => {}; }
    const wrapped = (() => 2) as () => number;
    export default () => 1;
  `, "names.ts");

  assert.deepEqual(
    metrics.functions.map((fn) => fn.name),
    ["handler", "onClick", "onHover", "onKey", "handleClick", "wrapped", "default"],
  );
});

test("ComplexityAnalyzer counts nullish coalescing, optional chains, catch and case in cyclomatic complexity", () => {
  const metrics = analyze(`
    export function pick(a, b) { return a ?? b; }
    export function chain(o) { return o?.a?.b; }
    export function twoChains(o, p) { return o?.a + p?.b; }
    export function optionalCall(fn) { return fn?.(); }
    export function guard(fn) { try { return fn(); } catch { return null; } }
    export function sw(k) { switch (k) { case 1: return 1; case 2: return 2; default: return 0; } }
    export function plain(o) { return o.a.b; }
  `, "cc.ts");

  const byName = new Map(metrics.functions.map((fn) => [fn.name, fn]));
  assert.equal(byName.get("pick")?.cyclomaticComplexity, 2);
  assert.equal(byName.get("pick")?.logicalOpCount, 1);
  // `o?.a?.b` は 1 連鎖なので 1 だけ加算する
  assert.equal(byName.get("chain")?.cyclomaticComplexity, 2);
  assert.equal(byName.get("twoChains")?.cyclomaticComplexity, 3);
  assert.equal(byName.get("optionalCall")?.cyclomaticComplexity, 2);
  assert.equal(byName.get("guard")?.cyclomaticComplexity, 2);
  assert.equal(byName.get("sw")?.cyclomaticComplexity, 3);
  assert.equal(byName.get("plain")?.cyclomaticComplexity, 1);
});
