"use client";

import { useActionState, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, Eye, EyeOff } from "lucide-react";
import { authClient } from "@gigpilot/auth/client";
import { Button, Callout, Field, Input } from "@gigpilot/ui";
import { setPasswordAction, type SetPasswordState } from "./actions";

const INITIAL: SetPasswordState = { error: null };

/** Forced first-login password change: new password + confirmation, nothing else. */
export function SetPasswordForm() {
  const id = useId();
  const router = useRouter();
  const [state, submit, pending] = useActionState(setPasswordAction, INITIAL);
  const [show, setShow] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const onSubmit = (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const form = new FormData(ev.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    const e: Record<string, string> = {};
    if (password.length < 10) e.password = "Use at least 10 characters.";
    if (confirm.length === 0) e.confirm = "Repeat your new password.";
    else if (password !== confirm) e.confirm = "The passwords don't match.";
    setFieldErrors(e);
    if (Object.keys(e).length > 0) return;
    submit(form);
  };

  const logout = async () => {
    await authClient.signOut();
    router.replace("/login");
    router.refresh();
  };

  return (
    <div>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4" aria-describedby={state.error ? `${id}-error` : undefined}>
        {state.error ? (
          <Callout tone="risk" icon={<CircleAlert />}>
            <span id={`${id}-error`}>{state.error}</span>
          </Callout>
        ) : null}
        <Field id={`${id}-password`} label="New password" error={fieldErrors.password} hint="At least 10 characters.">
          <div className="relative">
            <Input
              id={`${id}-password`}
              type={show ? "text" : "password"}
              name="password"
              autoComplete="new-password"
              aria-invalid={!!fieldErrors.password}
              data-testid="set-password-password"
              className="h-9 pr-9"
              autoFocus
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
        <Field id={`${id}-confirm`} label="Confirm password" error={fieldErrors.confirm}>
          <Input
            id={`${id}-confirm`}
            type={show ? "text" : "password"}
            name="confirm"
            autoComplete="new-password"
            aria-invalid={!!fieldErrors.confirm}
            data-testid="set-password-confirm"
            className="h-9"
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 h-10 w-full text-[14px]" data-testid="set-password-submit">
          Set password
        </Button>
      </form>
      <p className="mt-6 text-[13px] text-fg-3">
        Want to come back later?{" "}
        <button type="button" onClick={() => void logout()} className="font-medium text-fg underline-offset-4 hover:underline" data-testid="set-password-logout">
          Log out
        </button>
      </p>
    </div>
  );
}
