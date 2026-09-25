/**
 * Static catalogue of integrations. Adapters live in @gigpilot/providers; this
 * registry is the UI/DB-facing description shared by every package.
 */

export type IntegrationKind = "intelligence" | "creative" | "marketplace" | "orchestration";

export interface IntegrationDescriptor {
  key: string;
  name: string;
  kind: IntegrationKind;
  description: string;
  /** Env var names (never values) that configure this integration server-wide. */
  envVars: string[];
  /** Credential fields a tenant may store (encrypted) instead of env. */
  secretFields: { name: string; label: string }[];
  docsUrl?: string;
  paid: boolean;
}

export const INTEGRATIONS: IntegrationDescriptor[] = [
  {
    key: "factory",
    name: "Factory.ai",
    kind: "intelligence",
    description: "Primary cloud reasoning and agent execution. Uses Factory Router (auto) for model selection.",
    envVars: ["FACTORY_API_KEY", "FACTORY_DROID_BIN", "FACTORY_MODEL"],
    secretFields: [{ name: "FACTORY_API_KEY", label: "API key" }],
    docsUrl: "https://docs.factory.ai",
    paid: true,
  },
  {
    key: "gx",
    name: "GX Cluster",
    kind: "intelligence",
    description: "Local GX10 compute via the LiteLLM gateway — triage, extraction, classification and first-pass QA.",
    envVars: ["GX_BASE_URL", "GX_API_KEY", "GX_MODEL_FAST", "GX_MODEL_CODE", "GX_MODEL_AUTO"],
    secretFields: [{ name: "GX_API_KEY", label: "Gateway key" }],
    paid: false,
  },
  {
    key: "grok",
    name: "Grok / xAI",
    kind: "intelligence",
    description: "Current-web and X research for market intelligence and opportunity context.",
    envVars: ["XAI_API_KEY", "XAI_MODEL"],
    secretFields: [{ name: "XAI_API_KEY", label: "API key" }],
    docsUrl: "https://docs.x.ai",
    paid: true,
  },
  {
    key: "kie",
    name: "Kie.ai",
    kind: "creative",
    description: "Cost-sensitive image and video generation across many models.",
    envVars: ["KIE_API_KEY"],
    secretFields: [{ name: "KIE_API_KEY", label: "API key" }],
    docsUrl: "https://docs.kie.ai",
    paid: true,
  },
  {
    key: "higgsfield",
    name: "Higgsfield",
    kind: "creative",
    description: "Premium image/video generation for high-control or final-grade output.",
    envVars: ["HIGGSFIELD_API_KEY", "HIGGSFIELD_API_SECRET"],
    secretFields: [
      { name: "HIGGSFIELD_API_KEY", label: "API key" },
      { name: "HIGGSFIELD_API_SECRET", label: "API secret" },
    ],
    docsUrl: "https://higgsfield.ai",
    paid: true,
  },
  {
    key: "upwork",
    name: "Upwork",
    kind: "marketplace",
    description: "Official GraphQL API for job search. Proposals are prepared for owner submission.",
    envVars: ["UPWORK_CLIENT_ID", "UPWORK_CLIENT_SECRET"],
    secretFields: [
      { name: "UPWORK_CLIENT_ID", label: "Client ID" },
      { name: "UPWORK_CLIENT_SECRET", label: "Client secret" },
      { name: "UPWORK_ACCESS_TOKEN", label: "OAuth access token" },
    ],
    docsUrl: "https://www.upwork.com/developer/documentation/graphql/api/docs/index.html",
    paid: false,
  },
  {
    key: "freelancer",
    name: "Freelancer",
    kind: "marketplace",
    description: "Official REST API for project search and user-authorised bid placement.",
    envVars: ["FREELANCER_OAUTH_TOKEN"],
    secretFields: [{ name: "FREELANCER_OAUTH_TOKEN", label: "OAuth access token" }],
    docsUrl: "https://developers.freelancer.com",
    paid: false,
  },
  {
    key: "contra",
    name: "Contra",
    kind: "marketplace",
    description: "Opportunity notifications ingested from forwarded emails / webhooks. No scraping.",
    envVars: ["INBOUND_WEBHOOK_SECRET"],
    secretFields: [],
    docsUrl: "https://contra.com",
    paid: false,
  },
  {
    key: "fiverr",
    name: "Fiverr",
    kind: "marketplace",
    description: "Buyer brief notifications ingested from forwarded emails / webhooks. No scraping.",
    envVars: ["INBOUND_WEBHOOK_SECRET"],
    secretFields: [],
    docsUrl: "https://www.fiverr.com",
    paid: false,
  },
  {
    key: "web",
    name: "Public web feeds",
    kind: "marketplace",
    description: "Official public job APIs and RSS feeds intended for programmatic use.",
    envVars: [],
    secretFields: [],
    paid: false,
  },
  {
    key: "direct",
    name: "Direct outbound",
    kind: "marketplace",
    description: "Prospects you add manually or import — GigPilot analyses and prepares outreach.",
    envVars: [],
    secretFields: [],
    paid: false,
  },
  {
    key: "mock",
    name: "Demo marketplace",
    kind: "marketplace",
    description: "Simulated opportunity feed used in demo/test mode. Runs through the real pipeline.",
    envVars: [],
    secretFields: [],
    paid: false,
  },
  {
    key: "agentos",
    name: "AgentOS",
    kind: "orchestration",
    description: "Legenex AgentOS supervision. GigPilot exposes a pull-only supervision API for it.",
    envVars: ["AGENTOS_SUPERVISION_TOKEN", "AGENTOS_BASE_URL"],
    secretFields: [],
    paid: false,
  },
];

export const SOURCE_KEYS = ["upwork", "freelancer", "contra", "fiverr", "web", "direct", "mock"] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

export function integrationByKey(key: string): IntegrationDescriptor | undefined {
  return INTEGRATIONS.find((i) => i.key === key);
}
