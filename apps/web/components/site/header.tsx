import { siteUrls } from "@/lib/site";
import { getViewer } from "@/lib/session";
import { NavBar } from "./nav-bar";

/** Every section on the home page, numbered as its section rule is. `primary` links also show in the desktop bar. */
export const NAV_LINKS = [
  { href: "/#loop", label: "Loop", index: "01", primary: true },
  { href: "/#radar", label: "Radar", index: "02", primary: true },
  { href: "/#market", label: "Market", index: "03", primary: false },
  { href: "/#economics", label: "Economics", index: "04", primary: true },
  { href: "/#production", label: "Production", index: "05", primary: true },
  { href: "/#routing", label: "Routing", index: "06", primary: true },
  { href: "/#supervision", label: "Supervision", index: "07", primary: true },
  { href: "/#learning", label: "Learning", index: "08", primary: false },
];

/**
 * Auth-aware header. The session is resolved on the server for every request,
 * so the HTML that reaches the browser already contains the right links.
 *
 * `ctaAware`: the page has its own primary CTAs (marked `data-cta-watch`). While
 * one of them is on screen the header's button steps down to an outline so the
 * viewport only ever carries one solid orange action.
 */
export async function SiteHeader({ ctaAware = false }: { ctaAware?: boolean }) {
  const { signedIn } = await getViewer();
  const urls = siteUrls();
  return <NavBar signedIn={signedIn} urls={{ app: urls.app, login: urls.login, signup: urls.signup }} links={NAV_LINKS} ctaAware={ctaAware} />;
}
