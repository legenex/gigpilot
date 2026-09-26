import Link from "next/link";
import { Logo } from "@gigpilot/ui";

const PRODUCT = [
  { href: "/#loop", label: "The loop" },
  { href: "/#radar", label: "Opportunity Radar" },
  { href: "/#market", label: "Market intelligence" },
  { href: "/#economics", label: "Profitability scoring" },
  { href: "/#production", label: "Autonomous production" },
  { href: "/#routing", label: "Model routing" },
  { href: "/#supervision", label: "Human supervision" },
  { href: "/#learning", label: "Learning" },
];

const COMPANY = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="site-container grid gap-10 py-14 md:grid-cols-12 md:gap-6">
        <div className="md:col-span-5">
          <Logo />
          <p className="mt-4 max-w-[320px] text-[14px] leading-[22px] text-fg-muted">Find profitable work. Win it. Get it done.</p>
          <p className="label mt-6">Private beta</p>
        </div>
        <nav aria-label="Product" className="md:col-span-4 md:col-start-7">
          <p className="label">Product</p>
          <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5 md:grid-cols-1 lg:grid-cols-2">
            {PRODUCT.map((l) => (
              <li key={l.href}>
                <a href={l.href} className="focus-ring rounded-xs text-[14px] text-fg-2 transition-colors hover:text-fg">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Company" className="md:col-span-2">
          <p className="label">Company</p>
          <ul className="mt-4 space-y-2.5">
            {COMPANY.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="focus-ring rounded-xs text-[14px] text-fg-2 transition-colors hover:text-fg">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="border-t border-line">
        <div className="site-container flex flex-col gap-2 py-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[11px] tracking-[0.06em] text-fg-muted">© 2026 GigPilot</p>
          <p className="font-mono text-[11px] tracking-[0.06em] text-fg-muted">Product figures are illustrative. Money figures use GigPilot&apos;s own calculator.</p>
        </div>
      </div>
    </footer>
  );
}
