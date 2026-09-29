import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useIsBusy } from "../../lib/progress";

/**
 * Thin accent bar across the top of the viewport while requests are in flight
 * (and briefly on route change). Shows only if work lasts >150ms, trickles
 * toward ~90%, then completes to 100% and fades.
 */
export function TopProgressBar() {
  const busy = useIsBusy();
  const location = useLocation();
  const [routeBusy, setRouteBusy] = useState(false);
  const [value, setValue] = useState(0);
  const [visible, setVisible] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout>>();
  const trickle = useRef<ReturnType<typeof setInterval>>();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setRouteBusy(true);
    const t = setTimeout(() => setRouteBusy(false), 200);
    return () => clearTimeout(t);
  }, [location.pathname]);

  const working = busy || routeBusy;

  useEffect(() => {
    if (working) {
      clearTimeout(hideTimer.current);
      showTimer.current = setTimeout(() => {
        setVisible(true);
        setValue(0.12);
        trickle.current = setInterval(() => setValue((v) => v + (0.9 - v) * 0.12), 250);
      }, 150);
    } else {
      clearTimeout(showTimer.current);
      clearInterval(trickle.current);
      if (visible) {
        setValue(1);
        hideTimer.current = setTimeout(() => {
          setVisible(false);
          setValue(0);
        }, 350);
      }
    }
    return () => {
      clearTimeout(showTimer.current);
      clearInterval(trickle.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  return (
    <div aria-hidden className="fixed top-0 left-0 right-0 h-[2px] z-[90] pointer-events-none">
      <div
        className="h-full bg-accent origin-left"
        style={{
          transform: `scaleX(${value})`,
          opacity: visible ? 1 : 0,
          transition: `transform ${value === 0 ? 0 : 250}ms cubic-bezier(0.2,0,0,1), opacity 200ms ${value === 1 ? "150ms" : "0ms"}`,
          boxShadow: "0 0 8px var(--accent)",
        }}
      />
    </div>
  );
}
