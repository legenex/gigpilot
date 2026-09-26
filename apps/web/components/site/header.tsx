import { siteUrls } from "@/lib/site";
import { getViewer } from "@/lib/session";
import { NavBar } from "./nav-bar";

export const NAV_LINKS = [
  { href: "/#loop", label: "Loop", index: "01" },
  { href: "/#radar", label: "Radar", index: "02" },
  { href: "/#economics", label: "Economics", index: "04" },
  { href: "/#production", label: "Production", index: "05" },
  { href: "/#routing", label: "Routing", index: "06" },
  { href: "/#supervision", label: "Supervision", index: "07" },
];

/**
 * Auth-aware header. The session is resolved on the server for every request,
 * so the HTML that reaches the browser already contains the right links.
 */
export async function SiteHeader() {
  const { signedIn } = await getViewer();
  const urls = siteUrls();
  return <NavBar signedIn={signedIn} urls={{ app: urls.app, login: urls.login, signup: urls.signup }} links={NAV_LINKS} />;
}
