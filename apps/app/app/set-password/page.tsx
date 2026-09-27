import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@gigpilot/ui";
import { getSession } from "@/lib/session";
import { SetPasswordForm } from "./set-password-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Set your password" };

/**
 * Forced first-login password change (operator bootstrap). Reachable only
 * while mustChangePassword is true — every dashboard route redirects here,
 * and this page sends a completed user back to the dashboard.
 */
export default async function SetPasswordPage() {
  const ctx = await getSession();
  if (!ctx) redirect("/login");
  if (!ctx.mustChangePassword) redirect("/");
  return (
    <div className="grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-[360px]">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <h1 className="font-display text-[26px] font-semibold leading-8 tracking-[-0.03em] text-fg">Set your password</h1>
        <p className="mt-1.5 text-[13px] leading-5 text-fg-2">Choose a permanent password for your GigPilot account.</p>
        <div className="mt-7">
          <SetPasswordForm />
        </div>
      </div>
    </div>
  );
}
