import type { Metadata } from "next";

import "./globals.css";
import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { exceptions } from "@/db/schema";
import { isNull } from "drizzle-orm";
import { Frieze } from "@/ui/frieze";

export const metadata: Metadata = {
  title: "Settlement Reconciliation",
  description:
    "Multi-source settlement reconciliation: fuzzy matching across payments, orders, settlements, bank statements and invoices, with an honest exception queue.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await ensureBootstrapped();
  const db = await getDb();
  const pending = await db.select({ id: exceptions.id }).from(exceptions).where(isNull(exceptions.resolvedByReviewId));

  return (
    <html lang="en">
      <body>
        <Frieze pendingExceptions={pending.length} />
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
