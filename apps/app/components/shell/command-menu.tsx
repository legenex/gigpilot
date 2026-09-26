"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ClipboardPaste, FileText, PanelLeft, RefreshCw, SquareKanban } from "lucide-react";
import { CommandPalette, Kbd, useToast, type CommandGroupDef } from "@gigpilot/ui";
import { refreshAllSourcesAction } from "@/lib/actions/integrations";
import { NAV } from "./nav";

interface SearchHit {
  kind: "opportunity" | "job";
  id: string;
  title: string;
  hint: string;
}

export function CommandMenu({
  open,
  onOpenChange,
  onPaste,
  onToggleRail,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPaste: () => void;
  onToggleRail: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (res.ok) setHits(((await res.json()) as { hits: SearchHit[] }).hits);
      } catch {
        /* aborted */
      } finally {
        setLoading(false);
      }
    }, 160);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [query, open]);

  const close = () => {
    onOpenChange(false);
    setQuery("");
    setHits([]);
  };

  const groups = useMemo<CommandGroupDef[]>(() => {
    const shownHits = query.trim().length >= 2 ? hits : [];
    return [
      {
        heading: "Results",
        items: shownHits.map((h) => ({
          id: `${h.kind}-${h.id}`,
          label: h.title,
          hint: h.hint,
          keywords: [query],
          icon: h.kind === "job" ? <SquareKanban /> : <FileText />,
          onSelect: () => {
            close();
            router.push(h.kind === "job" ? `/jobs/${h.id}` : `/radar/${h.id}`);
          },
        })),
      },
      {
        heading: "Actions",
        items: [
          {
            id: "refresh-sources",
            label: "Refresh sources",
            hint: "user-directed",
            icon: <RefreshCw />,
            keywords: ["sync", "fetch", "scout", "source"],
            onSelect: async () => {
              close();
              const res = await refreshAllSourcesAction();
              toast(res.ok ? { title: `Refresh queued for ${res.data?.count ?? 0} enabled source${res.data?.count === 1 ? "" : "s"}`, tone: "success" } : { title: res.error, tone: "error" });
            },
          },
          {
            id: "paste-opportunity",
            label: "Paste an opportunity…",
            hint: "manual intake",
            icon: <ClipboardPaste />,
            keywords: ["add", "manual", "contra", "fiverr", "upwork", "direct", "new"],
            onSelect: () => {
              close();
              onPaste();
            },
          },
          {
            id: "goto-opportunity",
            label: "Go to opportunity…",
            hint: "type a title",
            icon: <FileText />,
            keywords: ["find", "search", "opportunity"],
            onSelect: () => setQuery(query.trim().length >= 2 ? query : ""),
          },
          {
            id: "toggle-rail",
            label: "Toggle sidebar",
            icon: <PanelLeft />,
            shortcut: <Kbd>[</Kbd>,
            onSelect: () => {
              close();
              onToggleRail();
            },
          },
        ],
      },
      {
        heading: "Navigate",
        items: NAV.map((n) => {
          const Icon = n.icon;
          return {
            id: `nav-${n.href}`,
            label: n.label,
            icon: <Icon strokeWidth={1.75} />,
            shortcut: (
              <span className="flex gap-1">
                <Kbd>G</Kbd>
                <Kbd>{n.key.toUpperCase()}</Kbd>
              </span>
            ),
            onSelect: () => {
              close();
              router.push(n.href);
            },
          };
        }),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits, query, router, onPaste, onToggleRail, toast]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={(v) => (v ? onOpenChange(true) : close())}
      groups={groups}
      query={query}
      onQueryChange={setQuery}
      loading={loading}
      placeholder="Search opportunities, jobs, or run a command…"
      footer={
        <>
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> select
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> close
          </span>
        </>
      }
    />
  );
}
