import type { Metadata } from "next";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <AuthForm mode="login" next={typeof next === "string" ? next : undefined} />;
}
