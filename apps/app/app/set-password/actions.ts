"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { completeForcedPasswordChange, ForcedPasswordError } from "@gigpilot/auth";

export interface SetPasswordState {
  error: string | null;
}

/**
 * Completes the forced first-login password change. Validation runs on the
 * client and again here; the password itself is handled entirely by Better
 * Auth (hashing, storage, session revocation) inside
 * completeForcedPasswordChange — never by this action.
 */
export async function setPasswordAction(_prev: SetPasswordState, formData: FormData): Promise<SetPasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password.length < 10) return { error: "Use at least 10 characters for your new password." };
  if (password !== confirm) return { error: "The passwords don't match." };
  try {
    await completeForcedPasswordChange(await headers(), password);
  } catch (err) {
    if (err instanceof ForcedPasswordError) return { error: err.message };
    console.error(JSON.stringify({ level: "warn", msg: "password change failed", error: err instanceof Error ? err.name : "error" }));
    return { error: "Could not save your password. Please try again." };
  }
  redirect("/");
}
