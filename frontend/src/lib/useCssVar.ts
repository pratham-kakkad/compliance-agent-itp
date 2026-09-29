import { useEffect, useState } from "react";

function read<K extends string>(names: K[]): Record<K, string> {
  const style = getComputedStyle(document.documentElement);
  const out = {} as Record<K, string>;
  for (const n of names) out[n] = style.getPropertyValue(`--${n}`).trim();
  return out;
}

/** Resolved values of CSS custom properties (for SVG/Recharts), re-read when the theme class changes. */
export function useCssVars<K extends string>(names: K[]): Record<K, string> {
  const key = names.join(",");
  const [vals, setVals] = useState(() => read(names));
  useEffect(() => {
    setVals(read(names));
    const obs = new MutationObserver(() => setVals(read(names)));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return vals;
}
