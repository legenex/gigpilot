import type { ReactNode } from "react";
import { SiteHeader } from "./header";
import { SiteFooter } from "./footer";

export function LegalPage({ title, updated, intro, children }: { title: string; updated: string; intro: ReactNode; children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" className="site-container pb-28 pt-16 sm:pt-24">
        <article className="mx-auto max-w-[680px]">
          <p className="label">Private beta · last updated {updated}</p>
          <h1 className="display-2 mt-4">{title}</h1>
          <div className="mt-6 rounded-md bg-surface-1 p-4 text-[15px] leading-[24px] text-fg-2 ring-1 ring-line-strong">{intro}</div>
          <div className="legal mt-10">{children}</div>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
