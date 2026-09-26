/** Serializable event shape shared by the SSE stream and server-rendered streams. */
export interface LiveEvent {
  id: string;
  seq: number;
  type: string;
  level: "debug" | "info" | "success" | "warn" | "error";
  agent: string | null;
  message: string;
  subjectType: string | null;
  subjectId: string | null;
  jobId: string | null;
  createdAt: string;
}

/** Which event families invalidate which pages (drives debounced router.refresh). */
export const REFRESH_RULES: { path: RegExp; prefixes: string[] }[] = [
  { path: /^\/$/, prefixes: ["opportunity.", "proposal.", "application.", "job.", "delivery.", "cost.", "qa.", "repair.", "budget.", "agent.", "step."] },
  { path: /^\/radar/, prefixes: ["opportunity.", "proposal.", "application."] },
  { path: /^\/markets/, prefixes: ["market.", "opportunity.discovered"] },
  { path: /^\/applications/, prefixes: ["proposal.", "application.", "job.created"] },
  { path: /^\/jobs/, prefixes: ["job.", "workflow.", "step.", "qa.", "repair.", "delivery.", "generation.", "cost.", "budget."] },
  { path: /^\/production/, prefixes: ["job.", "workflow.", "step.", "qa.", "repair.", "generation.", "delivery."] },
  { path: /^\/agents/, prefixes: ["agent.", "step.", "opportunity.", "proposal.", "qa.", "repair.", "market.", "source.", "generation.", "workflow."] },
  { path: /^\/costs/, prefixes: ["cost.", "generation.", "job.", "budget."] },
  { path: /^\/integrations/, prefixes: ["provider.", "source."] },
];

export function shouldRefresh(pathname: string, type: string): boolean {
  return REFRESH_RULES.some((r) => r.path.test(pathname) && r.prefixes.some((p) => type.startsWith(p)));
}
