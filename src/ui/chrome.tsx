"use client";

import { usePathname } from "next/navigation";

import { Frieze } from "./frieze";
import { Gate } from "./gate";

/**
 * The building around the pages.
 *
 * The intro at "/" is the front elevation and carries its own navigation, so
 * the frieze is not drawn over it and the page gutter is not applied to it --
 * everywhere else both are. The ground layer holds every ambient texture in
 * the skin on one fixed element behind the content, and the gate is the
 * transition between rooms.
 *
 * `children` stays server-rendered: it is passed through this client boundary
 * as a prop, not imported across it.
 */
export function Chrome({
  pendingExceptions,
  children,
}: {
  pendingExceptions: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isIntro = pathname === "/";

  return (
    <>
      <div className="ground" aria-hidden />
      {!isIntro && <Frieze pendingExceptions={pendingExceptions} />}
      <main className={isIntro ? "landing" : "page"}>{children}</main>
      <Gate />
    </>
  );
}
