import type { Metadata } from "next";
import { LegalPage } from "@/components/site/legal-page";

export const metadata: Metadata = {
  title: "Terms",
  description: "Terms for GigPilot early access.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms"
      updated="September 2026"
      intro={
        <>
          GigPilot is in early access. These placeholder terms describe how the service works today; full terms of service will be
          published before general availability.
        </>
      }
    >
      <h2>Early access</h2>
      <p>The service is provided as-is while we build it. Features, limits and availability may change, and the service may be interrupted.</p>
      <h2>Your marketplaces, your accounts</h2>
      <p>
        You remain responsible for following each marketplace&apos;s terms. GigPilot&apos;s defaults are compliance-first: no scraping, no
        browser automation of marketplaces, and proposals submitted only where a marketplace officially permits it — after your approval.
      </p>
      <h2>Spend</h2>
      <p>
        Paid AI providers are disabled by default with a $0 daily limit. You decide when to enable them and set per-job and daily spend
        limits.
      </p>
      <h2>Review and approval</h2>
      <p>
        AI-produced work can be wrong. GigPilot asks for your approval before any commercial commitment and before any final delivery, and
        you are responsible for what you send to clients.
      </p>
    </LegalPage>
  );
}
