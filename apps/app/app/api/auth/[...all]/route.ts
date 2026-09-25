import { authRouteHandlers } from "@gigpilot/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return authRouteHandlers().GET(req);
}

export async function POST(req: Request) {
  return authRouteHandlers().POST(req);
}
