import { NextResponse, type NextRequest } from "next/server";
import { hasSessionCookie } from "@gigpilot/auth/cookies";

/**
 * Optimistic redirect for signed-out visitors. The authoritative check is
 * getSessionContext() in the dashboard layout and every server action.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (!hasSessionCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname + search)}` : "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|login|signup|_next/|favicon|icon|robots|.*\\.(?:svg|png|jpg|ico|webp|txt)$).*)"],
};
