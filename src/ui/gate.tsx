"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * The vault gate: the page-to-page transition.
 *
 * A ledger house has a vault and the vault has a two-leaf brass gate. On
 * arrival the leaves stand closed across the viewport, hold for a beat, and
 * draw back to either side, cutting the brass seam that ran down the axis.
 *
 * It plays on ARRIVAL rather than on the click, and that is a safety property
 * rather than a stylistic one: the component only mounts once the new route has
 * committed, so there is no state in which the gate is closed and waiting for a
 * navigation that may never finish. A failed or cancelled navigation leaves
 * nothing on the screen because nothing was ever put there.
 *
 * Three further guarantees, all of them load-bearing:
 *
 *   - the overlay is pointer-events:none for its whole life, so it cannot eat
 *     a click even mid-animation;
 *   - it unmounts on animationend AND on a timer, because a backgrounded tab
 *     never delivers animationend and a gate that stayed would cover the page;
 *   - it does not run on first mount, so a cold load is not interrupted.
 *
 * Under prefers-reduced-motion it never mounts at all. That is the honest
 * reading of "reduced": not a faster gate, no gate.
 */
export function Gate() {
  const pathname = usePathname();
  const mounted = useRef(false);
  const [play, setPlay] = useState(0);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    setPlay((n) => n + 1);
    // 900ms against a 620ms animation. The margin is for the frame the browser
    // spends starting it; the timer exists for the case where animationend
    // never arrives at all.
    const timer = setTimeout(() => setPlay(0), 900);
    return () => clearTimeout(timer);
  }, [pathname]);

  if (play === 0) return null;

  return (
    // The key restarts the animation when a second navigation lands while the
    // first gate is still open.
    <div className="gate" aria-hidden key={play}>
      <div className="gate-leaf gate-leaf-l" onAnimationEnd={() => setPlay(0)} />
      <div className="gate-leaf gate-leaf-r" />
      <div className="gate-seam" />
    </div>
  );
}
