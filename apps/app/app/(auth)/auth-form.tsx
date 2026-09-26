"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useSyncExternalStore } from "react";
import { CircleAlert, Eye, EyeOff } from "lucide-react";
import { authClient } from "@gigpilot/auth/client";
import { Button, Callout, Field, Input } from "@gigpilot/ui";
import { safeNext } from "@/lib/safe-next";

function friendly(mode: "login" | "signup", err: { status?: number; message?: string; code?: string } | null | undefined): string {
  if (!err) return "Something went wrong. Please try again.";
  const msg = err.message ?? "";
  if (err.status === 429) return /account/i.test(msg) ? msg : "Too many attempts. Wait a minute and try again.";
  if (mode === "login" && (err.status === 401 || /invalid/i.test(msg))) return "That email and password don't match. Check them and try again.";
  if (mode === "signup" && (err.status === 422 || /exist/i.test(msg))) return "An account with this email already exists — log in instead.";
  if (err.status === 403) return msg || "Sign-up is invite-only for this GigPilot instance.";
  if (/password/i.test(msg)) return msg;
  return msg || "Something went wrong. Please try again.";
}

export function AuthForm({ mode, next }: { mode: "login" | "signup"; next?: string }) {
  const id = useId();
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const dest = mode === "signup" ? "/" : safeNext(next);
  // Pre-hydration clicks would fall back to a native form GET and reload the page.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // Inputs are uncontrolled (read from FormData on submit) so anything typed
  // before hydration survives — controlled inputs would be reset to "".
  const validate = (name: string, email: string, password: string) => {
    const e: Record<string, string> = {};
    if (mode === "signup" && name.trim().length < 2) e.name = "Tell us your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) e.email = "Enter a valid email address.";
    if (mode === "signup" ? password.length < 10 : password.length === 0) e.password = mode === "signup" ? "Use at least 10 characters." : "Enter your password.";
    setFieldErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    setError(null);
    const form = new FormData(ev.currentTarget);
    const name = String(form.get("name") ?? "");
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    if (!validate(name, email, password)) return;
    setPending(true);
    try {
      const res =
        mode === "login"
          ? await authClient.signIn.email({ email: email.trim(), password })
          : await authClient.signUp.email({ name: name.trim(), email: email.trim(), password });
      if (res.error) {
        setError(friendly(mode, res.error));
        setPending(false);
        return;
      }
      router.replace(dest);
      router.refresh();
    } catch {
      setError("Network error — check your connection and try again.");
      setPending(false);
    }
  };

  const otherHref = mode === "login" ? `/signup` : `/login${next && safeNext(next) !== "/" ? `?next=${encodeURIComponent(safeNext(next))}` : ""}`;

  return (
    <div>
      <h1 className="font-display text-[26px] font-semibold leading-8 tracking-[-0.03em] text-fg">{mode === "login" ? "Log in" : "Create your workspace"}</h1>
      <p className="mt-1.5 text-[13px] leading-5 text-fg-2">
        {mode === "login" ? "Welcome back. Your agents kept working." : "Start in demo mode — sourcing runs through the real pipeline with zero paid spend."}
      </p>
      <form onSubmit={submit} noValidate className="mt-7 flex flex-col gap-4" aria-describedby={error ? `${id}-error` : undefined}>
        {error ? (
          <Callout tone="risk" icon={<CircleAlert />}>
            <span id={`${id}-error`}>{error}</span>
          </Callout>
        ) : null}
        {mode === "signup" ? (
          <Field id={`${id}-name`} label="Name" error={fieldErrors.name}>
            <Input
              id={`${id}-name`}
              name="name"
              autoComplete="name"
              aria-invalid={!!fieldErrors.name}
              data-testid="signup-name"
              className="h-9"
              autoFocus
            />
          </Field>
        ) : null}
        <Field id={`${id}-email`} label="Work email" error={fieldErrors.email}>
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            inputMode="email"
            name="email"
            aria-invalid={!!fieldErrors.email}
            data-testid={mode === "login" ? "login-email" : "signup-email"}
            className="h-9"
            autoFocus={mode === "login"}
          />
        </Field>
        <Field id={`${id}-password`} label="Password" error={fieldErrors.password} hint={mode === "signup" ? "At least 10 characters." : undefined}>
          <div className="relative">
            <Input
              id={`${id}-password`}
              type={show ? "text" : "password"}
              name="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              aria-invalid={!!fieldErrors.password}
              data-testid={mode === "login" ? "login-password" : "signup-password"}
              className="h-9 pr-9"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-xs text-fg-3 hover:text-fg"
              aria-label={show ? "Hide password" : "Show password"}
              aria-pressed={show}
            >
              {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={pending} disabled={!hydrated} className="mt-1 h-10 w-full text-[14px]" data-testid={mode === "login" ? "login-submit" : "signup-submit"}>
          {mode === "login" ? "Log in" : "Create workspace"}
        </Button>
      </form>
      <p className="mt-6 text-[13px] text-fg-3">
        {mode === "login" ? "New to GigPilot? " : "Already have an account? "}
        <Link href={otherHref} className="font-medium text-fg underline-offset-4 hover:underline">
          {mode === "login" ? "Create a workspace" : "Log in"}
        </Link>
      </p>
    </div>
  );
}
