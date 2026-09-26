/**
 * Deterministic feature lexicon. Extracts the concrete features a brief
 * EXPLICITLY asks for ("Stripe billing", "magic-link login", "document
 * upload", "webhook tests" …) and checks a produced code artifact for
 * evidence of each one. Used by triage (analysis.requestedFeatures), the
 * planner (per-deliverable acceptance criteria) and QA (a MAJOR
 * `missing_feature` finding per feature without evidence).
 *
 * Evidence is a keyword/structure signal in SOURCE files (docs do not count
 * for code features) — it proves a feature was at least attempted, never that
 * it works. Delivery notes say so.
 */

export interface FeatureDef {
  key: string;
  /** Client-facing label, e.g. "Stripe billing". */
  label: string;
  /** Matches the brief when the client explicitly asks for it. */
  brief: RegExp;
  /** Matches produced files (path + content) that implement it. */
  evidence: RegExp;
  /** Where evidence must be found: source files (default), docs (README/RUNBOOK), tests, or any file. */
  evidenceIn?: "source" | "docs" | "tests" | "any";
  /** Quality targets (e.g. Lighthouse 90+) cannot be verified from files — listed as "not verified". */
  verifiable?: boolean;
  /** Families where the feature applies (default: code families). */
  families?: string[];
}

export const CODE_FAMILIES = ["web-app-builds", "ai-automation"];

export const FEATURES: FeatureDef[] = [
  { key: "stripe_billing", label: "Stripe billing", brief: /\bstripe\b|\bsubscription billing\b|\bbilling\b.{0,40}\b(subscriptions?|payments?|checkout)\b/i, evidence: /stripe|checkout\.sessions|billing_portal|subscription/i },
  { key: "magic_link_login", label: "Magic-link login", brief: /magic[- ]link/i, evidence: /magic[-_ ]?link|signInWithOtp|sendMagicLink|verifyMagicLink/i },
  { key: "document_upload", label: "Document upload", brief: /\b(document|file|pdf|image)s?\s+(upload|uploads|upload\/download)\b|\bupload(ing)?\s+(documents?|files?|pdfs?)\b/i, evidence: /upload/i },
  { key: "webhook_tests", label: "Webhook tests", brief: /\btests?\b[^.\n]{0,40}\bwebhooks?\b|\bwebhook\b[^.\n]{0,20}\btests?\b/i, evidence: /webhook/i, evidenceIn: "tests" },
  { key: "webhooks", label: "Webhook handling", brief: /\bwebhooks?\b/i, evidence: /webhook/i },
  { key: "request_tracking", label: "Request tracking", brief: /\brequest tracking\b|\btrack(ing)? (client |customer )?requests\b/i, evidence: /\brequests?\b.{0,40}\b(status|track)|trackRequest|request_status/i },
  { key: "headless_cms", label: "Headless CMS", brief: /\b(headless )?cms\b|\bsanity\b|\bcontentful\b|\bstrapi\b/i, evidence: /\bcms\b|sanity|contentful|strapi|CMS_API_URL/i },
  { key: "sitemap", label: "Sitemap", brief: /\bsitemap\b/i, evidence: /sitemap/i },
  { key: "contact_form", label: "Contact form", brief: /\bcontact form\b/i, evidence: /contact/i },
  { key: "spam_protection", label: "Spam protection", brief: /\bspam protection\b|\bhoneypot\b|\bcaptcha\b|\banti-?spam\b/i, evidence: /honeypot|spam|captcha/i },
  { key: "seo_metadata", label: "SEO metadata", brief: /\bseo metadata\b|\bmeta tags\b|\bopen graph\b|\bmetadata\b/i, evidence: /metadata|openGraph|og:title|<meta/i },
  { key: "role_based_access", label: "Role-based access", brief: /\brole[- ]based access\b|\brbac\b|\bpermissions?[- ]aware\b|\bpermission-aware\b/i, evidence: /\brole|permission|rbac/i },
  { key: "csv_export", label: "CSV export", brief: /\bcsv export\b|\bexport (to )?csv\b/i, evidence: /csv/i },
  { key: "email_capture", label: "Email capture / list sign-up", brief: /\bemail capture\b|\bmailchimp\b|\bwaitlist\b/i, evidence: /mailchimp|subscribe|waitlist|email/i },
  { key: "slack_alerts", label: "Slack alerts", brief: /\bslack\b[^.\n]{0,20}\b(alerts?|notifications?|channel|summary|post)\b|\b(alerts?|post|flag)[^.\n]{0,30}\bslack\b/i, evidence: /slack/i },
  { key: "retry_backoff", label: "Retry with backoff", brief: /\bbackoff\b|\bretr(y|ies)\b[^.\n]{0,30}\b(429|rate limits?)\b/i, evidence: /backoff|withRetry|retry/i },
  { key: "dedupe", label: "Deduplication", brief: /\bdedupe|\bde-?dup|\bdeduplicat|\bduplicates?\b/i, evidence: /dedupe|dedup|duplicate/i },
  { key: "dead_letter", label: "Dead-letter log", brief: /\bdead[- ]letter\b/i, evidence: /dead[-_ ]?letter|deadLetter/i },
  { key: "ocr_extraction", label: "OCR / document field extraction", brief: /\bocr\b|\bextract (invoice )?fields\b/i, evidence: /\bocr\b|extractFields|extractInvoice|tesseract/i },
  { key: "llm_classification", label: "LLM classification / triage", brief: /\bclassif(y|ication)\b|\btriage[s]? incoming\b|\bintent\b/i, evidence: /classif|intent/i },
  { key: "rag_retrieval", label: "Retrieval with citations (RAG)", brief: /\brag\b|\bretrieval\b|\bcitations?\b|\bvector (database|search|store)\b/i, evidence: /retriev|citation|embedding|vector/i },
  { key: "enrichment", label: "Lead enrichment", brief: /\benrich(ment)?\b/i, evidence: /enrich/i },
  { key: "scoring_rules", label: "Scoring rules", brief: /\bscore (it|them|leads?)\b|\bicp rules\b|\blead scoring\b/i, evidence: /\bscore|icp/i },
  { key: "evaluation", label: "Evaluation set / results", brief: /\beval(uation)? (set|results)\b|\bevaluation\b/i, evidence: /\beval/i, evidenceIn: "any" },
  { key: "audit_log", label: "Audit log", brief: /\baudit (log|trail)\b|\blog every decision\b/i, evidence: /audit|decision log|logDecision/i },
  { key: "admin_page", label: "Admin page", brief: /\badmin (page|panel|dashboard)\b/i, evidence: /admin/i },
  { key: "dashboard_views", label: "Dashboard views", brief: /\bdashboard\b/i, evidence: /dashboard/i, families: ["web-app-builds"] },
  { key: "client_portal", label: "Client portal", brief: /\b(client|customer) portal\b/i, evidence: /portal/i },
  { key: "redirect_map", label: "Redirect map", brief: /\bredirect map\b|\bpreserve urls\b/i, evidence: /redirect/i },
  { key: "i18n", label: "Multi-language (i18n)", brief: /\bi18n\b|\bmulti-?lingual\b|\bmulti-?language\b/i, evidence: /i18n|locale/i },
  { key: "readme", label: "README", brief: /\breadme\b/i, evidence: /readme/i, evidenceIn: "docs" },
  { key: "runbook", label: "Runbook", brief: /\brunbook\b/i, evidence: /runbook/i, evidenceIn: "docs" },
  { key: "deployment_guide", label: "Deployment guide", brief: /\bdeployment guide\b|\bdeploy(ment)? (docs|instructions)\b/i, evidence: /deploy/i, evidenceIn: "docs" },
  { key: "automated_tests", label: "Automated tests", brief: /\b(unit|integration|automated|e2e|end-to-end)\s+tests?\b|\binclude tests\b|\btest suite\b|\btests? for\b|\bci\/cd\b|\bgithub actions\b|\bci pipeline\b/i, evidence: /\b(describe|it|test)\(/, evidenceIn: "tests" },
  { key: "lighthouse", label: "Lighthouse / Core Web Vitals target", brief: /\blighthouse\b|\bcore web vitals\b|\blcp\b/i, evidence: /lighthouse/i, verifiable: false },
];

/** Features the brief explicitly asks for (family-scoped; code families by default). */
export function detectRequestedFeatures(text: string, family: string): FeatureDef[] {
  const t = ` ${text.replace(/\s+/g, " ")} `;
  const found = FEATURES.filter((f) => (f.families ?? CODE_FAMILIES).includes(family) && f.brief.test(t));
  // "Webhook tests" subsumes plain "webhook handling"? No — both are requested; keep both.
  return found;
}

/** Labels of the features explicitly requested (stored on the analysis). */
export function requestedFeatureLabels(text: string, family: string): string[] {
  return detectRequestedFeatures(text, family).map((f) => f.label);
}

export function featureByLabel(label: string): FeatureDef | undefined {
  const l = label.trim().toLowerCase();
  return FEATURES.find((f) => f.label.toLowerCase() === l || f.key === l);
}

/** True when the client explicitly requires tests / CI (tests_not_executed becomes MAJOR). */
export function briefRequiresTests(text: string): boolean {
  return /\b(unit|integration|automated|e2e|end-to-end|webhook|billing)\s+tests?\b|\binclude\s+(automated\s+)?tests\b|\btests?\s+for\b|\btest\s+suite\b|\btest coverage\b|\bci\/cd\b|\bgithub actions\b|\bci pipeline\b|\bcontinuous integration\b|\bwith tests\b|\btested with\b/i.test(text);
}

export interface ArtifactFile {
  path: string;
  content: string;
}

function isDoc(path: string): boolean {
  return /\.(md|mdx|txt)$/i.test(path) || /(^|\/)(readme|runbook|changelog)/i.test(path);
}
function isTest(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)\//i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path);
}
function isReport(path: string): boolean {
  return /test-report\.json$|TEST-REPORT\.md$/i.test(path);
}
/** Config/env files never count as feature evidence (an env var name is not an implementation). */
function isConfig(path: string): boolean {
  return /(^|\/)\.env|(^|\/)package(-lock)?\.json$|(^|\/)tsconfig[^/]*\.json$|(^|\/)pnpm-lock\.yaml$/i.test(path);
}

export interface FeatureCoverage {
  covered: FeatureDef[];
  missing: FeatureDef[];
  /** Requested but not verifiable from files (quality targets). */
  unverifiable: FeatureDef[];
}

/** Check a produced artifact for evidence of each requested feature. */
export function featureCoverage(features: FeatureDef[], files: ArtifactFile[]): FeatureCoverage {
  const out: FeatureCoverage = { covered: [], missing: [], unverifiable: [] };
  const usable = files.filter((f) => !isReport(f.path) && !isConfig(f.path));
  for (const f of features) {
    if (f.verifiable === false) {
      out.unverifiable.push(f);
      continue;
    }
    const where = f.evidenceIn ?? "source";
    const pool = usable.filter((file) => (where === "any" ? true : where === "docs" ? isDoc(file.path) : where === "tests" ? isTest(file.path) : !isDoc(file.path)));
    const hit = pool.some((file) => f.evidence.test(file.path) || f.evidence.test(file.content));
    (hit ? out.covered : out.missing).push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unpriced modalities (triage)
// ---------------------------------------------------------------------------

export interface ModalityHit {
  capability: "audio.voiceover" | "audio.dub" | "audio.music" | "video.generate" | "model.3d";
  label: string;
}

/**
 * Production modalities triage must never silently drop: voice/voiceover/narration,
 * animation/motion graphics/explainer video, audio/music/podcast, dubbing and 3D.
 */
export function detectModalities(text: string): ModalityHit[] {
  const t = text.toLowerCase();
  const hits: ModalityHit[] = [];
  if (/\bvoice[- ]?overs?\b|\bnarrat(ion|ed|or)\b|\bvoice actor\b|\bai voice\b|\bvo\b(?![a-z])/.test(t)) hits.push({ capability: "audio.voiceover", label: "voiceover / narration" });
  if (/\bdub(bing|bed)?\b|\blip[- ]?sync\b/.test(t)) hits.push({ capability: "audio.dub", label: "dubbing" });
  if (/\bmusic\b|\bsoundtrack\b|\bjingle\b|\bsound design\b|\bpodcast\b|\baudio (ad|spot|mix|editing)\b/.test(t)) hits.push({ capability: "audio.music", label: "music / audio production" });
  if (/\banimat(ed|ion)\b|\bmotion graphics?\b|\bexplainer (video)?\b|\b2d animation\b|\bwhiteboard video\b/.test(t)) hits.push({ capability: "video.generate", label: "animated / explainer video" });
  if (/\b3d\b|\bthree-dimensional\b|\bcgi\b|\bblender\b|\bglb\b/.test(t)) hits.push({ capability: "model.3d", label: "3D modelling / rendering" });
  return hits;
}

/** Deadline in days from phrases like "14 days", "2 weeks", "within 10 business days", "by October 12". */
export function parseDeadlineDays(text: string, now: Date): number | null {
  const t = text.replace(/\s+/g, " ");
  const num = (s: string) => {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, "a": 1 };
    return /^\d+$/.test(s) ? Number(s) : (words[s.toLowerCase()] ?? NaN);
  };
  const candidates: number[] = [];
  for (const m of t.matchAll(/\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen)[- ](?:business |working |calendar )?(days?|weeks?)\b/gi)) {
    const n = num(m[1]!);
    if (!Number.isFinite(n) || n <= 0) continue;
    const days = /week/i.test(m[2]!) ? n * 7 : n;
    // Ignore durations that describe something else ("30-day trial", "video of 14 days"?) — keep plausible delivery windows only.
    const before = t.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0).toLowerCase();
    const after = t.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 6).toLowerCase();
    if (/\b(trial|warranty|support|retainer|every|per|last|past|previous|first)\s*$/.test(before)) continue;
    const tail = t.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 20).toLowerCase();
    if (/^\s+(of|ago|old)\b/.test(after) || /^\s*(free\s+)?(trial|warranty|guarantee|refund|money-back|return|support|retainer)\b/.test(tail)) continue;
    if (days <= 120) candidates.push(days);
  }
  const weekWord = /\b(?:in|within|over)\s+a\s+week\b/i.exec(t);
  if (weekWord) candidates.push(7);
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const by = /\b(?:by|before|due|deadline:?)\s+(?:(\d{1,2})(?:st|nd|rd|th)?\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s*(\d{1,2})?(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i.exec(t);
  if (by) {
    const mName = by[2]!.toLowerCase();
    const month = months.findIndex((m) => m.startsWith(mName.slice(0, 3)));
    const day = Number(by[1] ?? by[3] ?? 1);
    let year = by[4] ? Number(by[4]) : now.getUTCFullYear();
    let d = Date.UTC(year, month, day);
    if (!by[4] && d < now.getTime() - 86_400_000) d = Date.UTC(++year, month, day);
    const days = Math.ceil((d - now.getTime()) / 86_400_000);
    if (days >= 0 && days <= 365) candidates.push(days);
  }
  const iso = /\b(?:by|before|due|deadline:?)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(t);
  if (iso) {
    const days = Math.ceil((Date.parse(`${iso[1]}T00:00:00Z`) - now.getTime()) / 86_400_000);
    if (days >= 0 && days <= 365) candidates.push(days);
  }
  if (!candidates.length) return null;
  return Math.min(...candidates);
}
