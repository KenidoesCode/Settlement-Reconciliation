import type { ReactNode } from "react";

export function Panel({
  title,
  right,
  children,
  className,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"panel " + (className ?? "")}>
      {title && (
        <div className="panel-title flex items-baseline justify-between gap-3">
          <span>{title}</span>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Figure({
  value,
  caption,
  tone,
}: {
  value: string;
  caption: string;
  tone?: "brass" | "carmine" | "jade";
}) {
  const colour =
    tone === "brass"
      ? "text-[var(--color-brass-bright)]"
      : tone === "carmine"
        ? "text-[var(--color-carmine)]"
        : tone === "jade"
          ? "text-[var(--color-jade)]"
          : "";
  return (
    <div>
      <p className={"figure " + colour}>{value}</p>
      <p className="label mt-1.5">{caption}</p>
    </div>
  );
}

export function Badge({
  kind,
  children,
}: {
  kind: "resolved" | "exception" | "unresolved" | "false" | "brass";
  children: ReactNode;
}) {
  return <span className={"badge badge-" + kind}>{children}</span>;
}

export function Row({ label, value, tone }: { label: string; value: string; tone?: "carmine" | "jade" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-rule)] pb-1.5">
      <span className="label">{label}</span>
      <span
        className={
          "mono " +
          (tone === "carmine"
            ? "text-[var(--color-carmine)]"
            : tone === "jade"
              ? "text-[var(--color-jade)]"
              : "text-[var(--color-ivory)]")
        }
      >
        {value}
      </span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="border border-dashed border-[var(--color-rule)] px-4 py-7 text-center text-sm text-[var(--color-ivory-faint)]">
      {children}
    </p>
  );
}

export function pct(value: number): string {
  return (value * 100).toFixed(1) + "%";
}
