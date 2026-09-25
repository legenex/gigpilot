"use client";
import { createAuthClient } from "better-auth/react";

/** Browser auth client. Same-origin on the dashboard (auth lives at APP_URL/api/auth). */
export const authClient = createAuthClient({ basePath: "/api/auth" });

export const { signIn, signUp, signOut, useSession } = authClient;
