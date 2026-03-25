import { useEffect, useState } from "react";

import { Button } from "@/components/Button";
import { helper } from "./utils/helper";

export function App(props: { title: string; children?: unknown }) {
  const [count, setCount] = useState(0);
  const value = helper(count as number);
  const unsafe = props as any;

  useEffect(() => {
    void import("./lazy");
  }, [count]);

  if (unsafe.children && count > 0) {
    return <section>{unsafe.children}</section>;
  }

  return (
    <main>
      <h1>{props.title}</h1>
      <Button onClick={() => setCount((current) => current + 1)} label={String(value)} />
    </main>
  );
}
