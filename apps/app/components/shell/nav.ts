import {
  Bot,
  Cable,
  Gauge,
  LayoutGrid,
  Radar,
  Receipt,
  Send,
  Settings2,
  SquareKanban,
  Telescope,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { NavCounts } from "@/lib/queries/shell";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  testId: string;
  /** Second key of the "g then key" navigation shortcut. */
  key: string;
  count?: keyof NavCounts;
  group: "Operate" | "Intelligence" | "System";
}

export const NAV: NavItem[] = [
  { href: "/", label: "Command Center", icon: Gauge, testId: "nav-command-center", key: "h", group: "Operate" },
  { href: "/radar", label: "Opportunity Radar", icon: Radar, testId: "nav-radar", key: "r", count: "pursue", group: "Operate" },
  { href: "/applications", label: "Applications", icon: Send, testId: "nav-applications", key: "a", count: "proposalsAwaiting", group: "Operate" },
  { href: "/jobs", label: "Jobs", icon: SquareKanban, testId: "nav-jobs", key: "j", count: "awaitingFinal", group: "Operate" },
  { href: "/production", label: "Production", icon: Workflow, testId: "nav-production", key: "p", group: "Operate" },
  { href: "/markets", label: "Market Lab", icon: Telescope, testId: "nav-markets", key: "m", group: "Intelligence" },
  { href: "/agents", label: "Agents", icon: Bot, testId: "nav-agents", key: "t", count: "runningAgents", group: "Intelligence" },
  { href: "/costs", label: "Costs", icon: Receipt, testId: "nav-costs", key: "c", group: "Intelligence" },
  { href: "/integrations", label: "Integrations", icon: Cable, testId: "nav-integrations", key: "i", group: "System" },
  { href: "/settings", label: "Settings", icon: Settings2, testId: "nav-settings", key: "s", group: "System" },
];

export const NAV_GROUPS = ["Operate", "Intelligence", "System"] as const;

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export { LayoutGrid };
