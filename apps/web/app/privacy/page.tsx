import type { Metadata } from "next";
import { LegalPage } from "@/components/site/legal-page";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How GigPilot handles data during the private beta.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      updated="September 2026"
      intro={
        <>
          GigPilot is in private beta. This page is an honest placeholder, not a full privacy policy. A complete policy will be published
          before general availability.
        </>
      }
    >
      <h2>What we collect during the beta</h2>
      <p>
        The account details you give us (name and email), the workspace data you create — opportunities, proposals, jobs, deliverables and
        settings — and the operational logs needed to run, secure and debug the service.
      </p>
      <h2>Marketplace data</h2>
      <p>
        GigPilot reads opportunities only through official marketplace APIs where they are permitted, notifications you choose to forward,
        public feeds and prospects you add yourself. It does not scrape marketplaces or automate their websites.
      </p>
      <h2>Credentials</h2>
      <p>
        Provider and marketplace credentials you add are encrypted at rest and are never shown back in full. Private files are served only
        to signed-in members of your workspace.
      </p>
      <h2>What we don&apos;t do</h2>
      <p>We don&apos;t sell personal data, and we don&apos;t send messages to your clients unless you turn that on.</p>
      <h2>Questions</h2>
      <p>Contact the GigPilot team through the channel listed in your beta invitation.</p>
    </LegalPage>
  );
}
