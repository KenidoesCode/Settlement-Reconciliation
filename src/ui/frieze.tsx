"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The frieze.
 *
 * A deco building carries its name across the entablature, not down one side.
 * The nav is that band: one line, wide capitals, a brass underline on the
 * current section, and a chevron course beneath it.
 */

const LINKS = [
  { href: "/overview", label: "Overview" },
  { href: "/runs", label: "Runs" },
  { href: "/exceptions", label: "Exceptions" },
  { href: "/review", label: "Review" },
  { href: "/evaluation", label: "Evaluation" },
  { href: "/failures", label: "Failures" },
  { href: "/audit", label: "Audit" },
  { href: "/developer", label: "Developer" },
];

export function Frieze({ pendingExceptions }: { pendingExceptions: number }) {
  const pathname = usePathname();

  return (
    <header className="frieze">
      <div className="frieze-inner">
        <Link href="/overview" className="mr-3 shrink-0">
          <span className="display text-[0.8125rem] tracking-[0.3em] text-[var(--color-brass-bright)]">
            SETTLEMENT RECONCILIATION
          </span>
        </Link>
        <nav aria-label="Sections" className="flex flex-wrap gap-x-6 gap-y-1">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={pathname === link.href || pathname.startsWith(link.href + "/") ? "page" : undefined}
              className="frieze-link"
            >
              {link.label}
              {link.href === "/exceptions" && pendingExceptions > 0 && (
                <span className="ml-1.5 text-[var(--color-amber)]">{pendingExceptions}</span>
              )}
            </Link>
          ))}
        </nav>
        <span className="frieze-link ml-auto text-[var(--color-carmine)]">Synthetic data</span>
      </div>
    </header>
  );
}
