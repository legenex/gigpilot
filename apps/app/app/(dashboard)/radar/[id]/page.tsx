import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { OpportunityPage } from "@/components/opportunity/detail";
import { getOpportunityDetail } from "@/lib/queries/opportunity";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: UUID.test(id) ? "Opportunity" : "Not found" };
}

export default async function OpportunityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await requireSession();
  const d = await getOpportunityDetail(ctx.tenantId, id);
  if (!d) notFound();
  return (
    <div className="page">
      <nav aria-label="Breadcrumb" className="mb-4">
        <Link href="/radar" className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
          <ChevronLeft className="size-3.5" /> Opportunity Radar
        </Link>
      </nav>
      <OpportunityPage d={d} />
    </div>
  );
}
