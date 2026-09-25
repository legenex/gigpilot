import { headers } from "next/headers";
import { isSignedIn } from "@gigpilot/auth";
import { Button, Logo } from "@gigpilot/ui";
import { siteUrls } from "@/lib/site";

export const dynamic = "force-dynamic";

export default async function Home() {
  const urls = siteUrls();
  const session = await isSignedIn(await headers());
  return (
    <main className="mx-auto max-w-6xl px-6">
      <nav className="flex h-16 items-center justify-between">
        <Logo />
        <div className="flex items-center gap-2">
          {session.signedIn ? (
            <Button asChild variant="primary" size="sm">
              <a href={urls.app}>Go to Dashboard</a>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <a href={urls.login}>Log in</a>
              </Button>
              <Button asChild variant="primary" size="sm">
                <a href={urls.signup}>Sign up</a>
              </Button>
            </>
          )}
        </div>
      </nav>
      <section className="py-32">
        <h1 className="font-display text-6xl font-semibold tracking-[-0.035em]">Find profitable work. Win it. Get it done.</h1>
      </section>
    </main>
  );
}
