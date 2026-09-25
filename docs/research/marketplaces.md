# Marketplace compliance research (official docs, read 2026-09-26)

**Rule:** GigPilot never scrapes, never bypasses CAPTCHA/auth/rate limits, and
only submits programmatically where a marketplace officially permits it through
a user-authorised integration — and always after an explicit owner approval.

Several official pages (upwork.com, Fiverr help/ToS) sit behind bot challenges;
the research agent did not bypass them. Items marked **VERIFY** need a human to
read the page in a browser before production use.

| Source | Search | Submit | Ingestion | Background polling | Cache limit |
|---|---|---|---|---|---|
| Upwork | on-demand, user-directed only | **no** (API) — MCP preview→confirm only; GigPilot prepares, owner submits | api (on demand) / manual paste | **not allowed** | **24h** |
| Freelancer | yes (API) | **yes** — `POST /projects/0.1/bids/`, one bid per owner approval | api | yes (respect RateLimit headers) | none stated |
| Contra | no API | no | manual paste / forwarded email | n/a | n/a |
| Fiverr | no seller API | no | manual paste / forwarded email | n/a | n/a |
| Public feeds (Remotive, WWR RSS, HN API, RemoteOK, Himalayas, Jobicy) | yes | no | api / rss | yes, with min intervals | attribution required |

## Upwork

- OAuth2 auth-code: authorize `https://www.upwork.com/ab/account-security/oauth2/authorize`,
  token `https://www.upwork.com/api/v3/oauth2/token`, GraphQL `https://api.upwork.com/graphql`.
- Search query `marketplaceJobPostingsSearch(marketPlaceJobFilter, searchType, sortAttributes)`;
  fields: id, title, description, amount{rawValue,currency}, hourlyBudgetMin/Max, skills,
  client{totalSpent,totalHires,location,...}, publishedDateTime, totalApplicants, ciphertext.
- API key use is "personal and internal use only" (VERIFY) — fine for internal V1, not for commercial SaaS without written approval.
- ToU: searching only for "a specific, documented, user-directed task"; **no continuous monitoring / cron polling**; cache ≤ 24h; no automating around write confirmations; no spam proposals.
- Adapter: `canSearch` (on-demand), `canSubmit: false`, `backgroundPollingAllowed: false`, `maxCacheTtlHours: 24`. GigPilot purges Upwork-sourced content after 24h.

## Freelancer.com

- OAuth2: `https://accounts.freelancer.com/oauth/authorize` / `/oauth/token`; header `Freelancer-OAuth-V1: <token>`; tokens last 30 days. Personal access tokens available (30 days, self only).
- Search: `GET https://www.freelancer.com/api/projects/0.1/projects/active/?query=&project_types[]=fixed&min_price=&full_description=true&job_details=true&limit=50`
  → `result.projects[]`: id, title, description, budget{minimum,maximum}, currency{code,exchange_rate}, type, bid_stats{bid_count,bid_avg}, jobs[], time_submitted (unix), owner_id, seo_url.
  URL: `https://www.freelancer.com/projects/{seo_url}` (VERIFY).
- Bid: `POST https://www.freelancer.com/api/projects/0.1/bids/` JSON `{project_id, bidder_id, amount, period, milestone_percentage, description}`; scopes `basic` + `fln:project_manage`. Errors: BID_LIMIT_EXCEEDED, BID_DESCRIPTION_CONTAINS_EMAIL, PROJECT_NOT_ACTIVE, …
- "Automatic Bidders will not be approved" — GigPilot is a "Work Sourcer with human-approved bid drafting".
- Sandbox: `https://www.freelancer-sandbox.com/api/...`.
- Rate limits per endpoint; headers `RateLimit-Limit` / `RateLimit-Remaining`; 429 on excess.

## Contra / Fiverr

- No public APIs; both ToS prohibit bots, crawlers and automated access. Permitted: the owner pastes a job/brief (or forwards notification emails from their own inbox) and submits in-app themselves.

## Public feeds

- Remotive `GET https://remotive.com/api/remote-jobs` — ≤ ~4 requests/day, must link back and credit Remotive.
- We Work Remotely RSS `https://weworkremotely.com/remote-jobs.rss` — poll ≥ 60 min, attribute links.
- Hacker News (Firebase/Algolia APIs only; never HTML) — monthly "Freelancer? Seeking freelancer?" thread.
- RemoteOK `GET https://remoteok.com/api` — element 0 is legal notice; link back (follow) + credit.
- Himalayas `https://himalayas.app/jobs/api` — link back + credit.
- Jobicy `https://jobicy.com/api/v2/remote-jobs` — ≤ 1 poll/hour, credit Jobicy.
