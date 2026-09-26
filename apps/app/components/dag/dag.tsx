import Link from "next/link";
import { cn, formatUsd } from "@gigpilot/ui";
import { agentName } from "@/lib/labels";

export interface DagNode {
  key: string;
  name: string;
  agent: string;
  kind?: string;
  dependsOn: string[];
  status?: string;
  provider?: string | null;
  model?: string | null;
  attempts?: number;
  maxAttempts?: number;
  costUsd?: number | null;
  estimatedCostUsd?: number | null;
}

export interface DagRepair {
  fromKey: string;
  toKey: string;
  label: string;
  status: string;
}

const STATUS_STYLE: Record<string, { ring: string; dot: string; text: string }> = {
  pending: { ring: "ring-line", dot: "bg-fg-4", text: "text-fg-3" },
  ready: { ring: "ring-line-strong", dot: "bg-fg-3", text: "text-fg-2" },
  running: { ring: "ring-info/60", dot: "bg-info", text: "text-fg" },
  succeeded: { ring: "ring-line-strong", dot: "bg-profit", text: "text-fg" },
  failed: { ring: "ring-risk/55", dot: "bg-risk", text: "text-fg" },
  blocked: { ring: "ring-warn/55", dot: "bg-warn", text: "text-fg" },
  skipped: { ring: "ring-line", dot: "bg-fg-4", text: "text-fg-3" },
  cancelled: { ring: "ring-line", dot: "bg-fg-4", text: "text-fg-3" },
  plan: { ring: "ring-line-strong", dot: "bg-fg-3", text: "text-fg" },
};

/** Longest-path layering + one barycentric ordering pass (keeps crossings low for small DAGs). */
function layout(nodes: DagNode[]) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (k: string): number => {
    if (layer.has(k)) return layer.get(k)!;
    if (visiting.has(k)) return 0; // cycle guard
    visiting.add(k);
    const n = byKey.get(k);
    const parents = (n?.dependsOn ?? []).filter((p) => byKey.has(p));
    const d = parents.length ? Math.max(...parents.map(depth)) + 1 : 0;
    visiting.delete(k);
    layer.set(k, d);
    return d;
  };
  nodes.forEach((n) => depth(n.key));
  const layers: string[][] = [];
  nodes.forEach((n) => {
    const d = layer.get(n.key) ?? 0;
    (layers[d] ??= []).push(n.key);
  });
  const index = new Map<string, number>();
  layers.forEach((keys, li) => {
    if (li > 0) {
      keys.sort((a, b) => {
        const bary = (k: string) => {
          const ps = (byKey.get(k)?.dependsOn ?? []).filter((p) => index.has(p));
          return ps.length ? ps.reduce((s, p) => s + index.get(p)!, 0) / ps.length : 0;
        };
        return bary(a) - bary(b);
      });
    }
    keys.forEach((k, i) => index.set(k, i));
  });
  return { layers, layer, index };
}

/**
 * Workflow DAG: HTML nodes over an SVG edge layer. Running steps animate their
 * incoming edges (static under reduced motion); repair loops draw as dashed
 * back-edges beneath the graph.
 */
export function Dag({
  nodes,
  repairs = [],
  compact,
  selectedKey,
  hrefs,
  className,
  label = "Workflow graph",
}: {
  nodes: DagNode[];
  repairs?: DagRepair[];
  compact?: boolean;
  selectedKey?: string | null;
  hrefs?: Record<string, string>;
  className?: string;
  label?: string;
}) {
  if (nodes.length === 0) return <p className="text-xs text-fg-3">No workflow steps planned yet.</p>;
  const { layers, layer, index } = layout(nodes);
  const W = compact ? 150 : 172;
  const H = compact ? 44 : 78;
  const GX = compact ? 32 : 36;
  const GY = compact ? 10 : 16;
  const maxRows = Math.max(...layers.map((l) => l.length));
  const repairBand = repairs.length ? (compact ? 28 : 44) : 0;
  const width = layers.length * W + (layers.length - 1) * GX;
  const graphH = maxRows * H + (maxRows - 1) * GY;
  const height = graphH + repairBand;
  const pos = (k: string) => {
    const li = layer.get(k) ?? 0;
    const col = layers[li]!;
    const offset = ((maxRows - col.length) * (H + GY)) / 2;
    return { x: li * (W + GX), y: offset + (index.get(k) ?? 0) * (H + GY) };
  };
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  const edges: { d: string; state: "done" | "active" | "idle" | "failed" }[] = [];
  for (const n of nodes) {
    for (const p of n.dependsOn) {
      if (!byKey.has(p)) continue;
      const a = pos(p);
      const b = pos(n.key);
      const x1 = a.x + W;
      const y1 = a.y + H / 2;
      const x2 = b.x;
      const y2 = b.y + H / 2;
      const mx = (x1 + x2) / 2;
      const parent = byKey.get(p)!;
      const state = n.status === "running" ? "active" : n.status === "failed" ? "failed" : parent.status === "succeeded" && ["succeeded", "running"].includes(n.status ?? "") ? "done" : "idle";
      edges.push({ d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, state });
    }
  }

  return (
    <div className={cn("relative w-full overflow-x-auto overscroll-x-contain pb-1", className)} role="group" aria-label={label}>
      <div className="relative" style={{ width, height, minWidth: width }}>
        <svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden>
          {edges.map((e, i) => (
            <path
              key={i}
              d={e.d}
              fill="none"
              strokeWidth={e.state === "active" ? 1.5 : 1}
              stroke={e.state === "active" ? "var(--gp-info)" : e.state === "done" ? "rgba(63,214,140,0.45)" : e.state === "failed" ? "rgba(242,85,90,0.55)" : "var(--gp-line-bright)"}
              strokeDasharray={e.state === "active" ? "4 4" : undefined}
              className={e.state === "active" ? "animate-flow motion-reduce:animate-none" : undefined}
            />
          ))}
          {repairs.map((r, i) => {
            if (!byKey.has(r.fromKey) || !byKey.has(r.toKey)) return null;
            const a = pos(r.fromKey);
            const b = pos(r.toKey);
            const x1 = a.x + W / 2;
            const x2 = b.x + W / 2;
            const y1 = a.y + H;
            const y2 = b.y + H;
            const low = graphH + repairBand - 8 - i * 6;
            const active = r.status === "running" || r.status === "planned";
            return (
              <g key={`r${i}`}>
                <path
                  d={`M${x1},${y1} C${x1},${low} ${x2},${low} ${x2},${y2}`}
                  fill="none"
                  stroke="var(--gp-warn)"
                  strokeOpacity={active ? 0.9 : 0.5}
                  strokeWidth={1.25}
                  strokeDasharray="3 4"
                  markerEnd="url(#dag-arrow)"
                  className={active ? "animate-flow motion-reduce:animate-none" : undefined}
                />
                <text x={(x1 + x2) / 2} y={low - 4} textAnchor="middle" className="fill-warn font-mono text-[10px]">
                  {r.label}
                </text>
              </g>
            );
          })}
          <defs>
            <marker id="dag-arrow" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--gp-warn)" opacity="0.8" />
            </marker>
          </defs>
        </svg>

        {nodes.map((n) => {
          const p = pos(n.key);
          const st = STATUS_STYLE[n.status ?? "plan"] ?? STATUS_STYLE.plan!;
          const selected = selectedKey === n.key;
          const running = n.status === "running";
          const cost = n.costUsd ?? null;
          const inner = (
            <>
              <span className="flex items-center gap-1.5">
                <span className={cn("size-1.5 shrink-0 rounded-full", st.dot, running && "animate-pulse-dot text-info")} aria-hidden />
                <span className={cn("truncate text-[12px] font-medium leading-4", st.text)}>{n.name}</span>
                {n.attempts && n.attempts > 1 ? (
                  <span className={cn("ml-auto shrink-0 font-mono text-[10px]", n.maxAttempts && n.attempts >= n.maxAttempts ? "text-risk" : "text-warn")}>
                    ×{n.attempts}
                    {n.maxAttempts ? `/${n.maxAttempts}` : ""}
                  </span>
                ) : null}
              </span>
              {!compact ? (
                <>
                  <span className="mt-1 block truncate font-mono text-[10px] uppercase tracking-[0.04em] text-fg-3">{agentName(n.agent)}</span>
                  <span className="mt-1 flex items-center gap-2 font-mono text-[10.5px] text-fg-3">
                    <span className="min-w-0 flex-1 truncate">{n.provider ? `${n.provider}/${n.model ?? "—"}` : n.status === "pending" ? "awaiting deps" : "—"}</span>
                    <span className="shrink-0 tabular text-fg-2">{cost !== null && cost > 0 ? formatUsd(cost, { cents: true }) : n.estimatedCostUsd ? `~${formatUsd(n.estimatedCostUsd, { cents: true })}` : ""}</span>
                  </span>
                </>
              ) : (
                <span className="mt-0.5 block truncate font-mono text-[10px] text-fg-3">{agentName(n.agent)}</span>
              )}
            </>
          );
          const cls = cn(
            "absolute block rounded-sm bg-surface-1 px-2.5 text-left ring-1 ring-inset transition-[box-shadow,background-color] duration-200",
            compact ? "py-1.5" : "py-2",
            st.ring,
            running && "bg-[color-mix(in_oklab,var(--gp-info)_7%,var(--gp-surface-1))] shadow-[0_0_0_3px_rgba(122,167,255,0.08)]",
            selected && "ring-2 ring-fg",
            hrefs && "hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            (n.status === "pending" || n.status === "skipped" || n.status === "cancelled") && "bg-transparent",
          );
          const style = { left: p.x, top: p.y, width: W, height: H };
          const aria = `${n.name}: ${n.status ?? "planned"}${n.attempts ? `, attempt ${n.attempts}` : ""}${n.provider ? `, ${n.provider}/${n.model}` : ""}`;
          return hrefs?.[n.key] ? (
            <Link key={n.key} href={hrefs[n.key]!} scroll={false} className={cls} style={style} data-testid="dag-node" data-step-key={n.key} data-status={n.status ?? "planned"} aria-label={aria} aria-current={selected ? "true" : undefined}>
              {inner}
            </Link>
          ) : (
            <div key={n.key} className={cls} style={style} data-testid="dag-node" data-step-key={n.key} data-status={n.status ?? "planned"} aria-label={aria} role="img">
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}
