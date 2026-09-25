# GigPilot design system

GigPilot should feel like the instrument panel of a well-funded AI company:
calm, dense, precise, alive. Marketing and dashboard share one identity and
one token set (`packages/ui/src/styles/theme.css`) but serve different jobs —
the site persuades, the cockpit operates.

## Identity

- **Concept — "flight recorder orange on graphite."** Aviation's international
  orange marks the things that matter (black boxes, instruments, safety). In
  GigPilot the accent marks *signal*: the live agent, the profitable
  opportunity, the action that needs the owner. It is used sparingly.
- **Mark.** A heading-indicator ring with a course chevron (`<Logo/>`). No
  gradients on the mark.
- **Voice.** Direct, numerate, confident. Prefer numbers to adjectives. Never
  "revolutionary", "supercharge", "unleash", "seamless".

## Tokens (dark-first, dark-only V1)

| Token | Value | Use |
|---|---|---|
| `--gp-bg` | `#08090B` | page |
| `--gp-bg-raised` | `#0C0D10` | app chrome, sidebars |
| `--gp-surface-1/2/3` | `#111317 / #16181D / #1C1F25` | panels, hovers, pressed |
| `--gp-line` / `--gp-line-strong` | `rgba(255,255,255,.07) / .12` | hairlines — prefer lines over boxes |
| `--gp-fg` / `--gp-fg-2` / `--gp-fg-3` | `#EDEEF0 / #A1A6AE / #676C75` | text hierarchy |
| `--gp-accent` | `#FF6B2C` | signal (international orange) |
| `--gp-profit` | `#3FD68C` | profit, pass, healthy |
| `--gp-warn` | `#F2B84B` | caution, degraded |
| `--gp-risk` | `#F2555A` | failure, high risk, blocked |
| `--gp-info` | `#7AA7FF` | neutral info, links in data |
| `--gp-violet` / `--gp-cyan` | `#A493FF / #56CFE1` | secondary data series |

Type: **Schibsted Grotesk** (display, 600–700, tracking −0.02 to −0.035em),
**Inter** (UI, `cv11 ss01`, tabular numerals in data), **JetBrains Mono**
(telemetry labels, IDs, costs in tables, 11–12px, uppercase + 0.06em tracking
for eyebrow labels).

Scale (px): 11 · 12 · 13 · 14 · 16 · 18 · 22 · 28 · 36 · 48 · 64 · 84.
Dashboard body is 13px; marketing body 16–18px.

Radii: `--gp-r-xs 4px` (badges, inputs), `--gp-r-sm 6px` (buttons),
`--gp-r-md 8px` (panels), `--gp-r-lg 12px` (hero surfaces only). Avoid
pill-shaped everything; avoid stacks of rounded cards.

Motion: `--gp-ease-out cubic-bezier(.16,1,.3,1)`, `--gp-ease-in-out
cubic-bezier(.65,0,.35,1)`; durations 120 / 200 / 320 / 560ms. Motion must
explain state (data arriving, agent working, path completing) — never decorate.
Respect `prefers-reduced-motion` everywhere (static fallbacks).

## Rules

1. **Lines over boxes.** Use hairline dividers and alignment to group; use a
   surface only when content is interactive or elevated.
2. **One accent moment per view.** Orange marks the single most important
   signal/action. Everything else is graphite, white and data colours.
3. **Numbers are first-class.** Tabular numerals, right-aligned money, mono for
   IDs and costs. Show units. Show deltas.
4. **Live, not busy.** Status dots pulse only when something is actually
   running. Streams append smoothly; nothing jitters on refresh.
5. **Dense but breathable.** 32–36px table rows, 12–16px panel padding in the
   app; generous 96–160px section rhythm on the site.
6. **No template tells.** No purple→blue gradients, no glassmorphism cards, no
   emoji bullets, no generic "feature grid of 6 cards with icons", no stock
   imagery, no default shadcn look (restyle every primitive to these tokens).
7. **Focus is visible.** 2px accent focus ring offset on graphite; all
   interactive elements keyboard reachable; contrast ≥ 4.5:1 for text.

## Components (`@gigpilot/ui`)

Core: `Logo`, `Button`, `Badge`, `StatusDot`, `Kbd`, `Panel`, `Metric`,
`DataTable`, `Tabs`, `Dialog`/`Sheet`, `CommandPalette` (⌘K), `Sparkline`,
`BarMeter`, `EmptyState`, `Skeleton`, `Toast`. Icons: `lucide-react` at
14–16px, stroke 1.75, used only where they aid scanning.
