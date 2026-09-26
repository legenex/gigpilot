"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";

type ToastTone = "neutral" | "success" | "error" | "info";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastApi {
  toast: (t: { title: string; description?: string; tone?: ToastTone; durationMs?: number }) => void;
}

const Ctx = createContext<ToastApi | null>(null);

const dot: Record<ToastTone, string> = {
  neutral: "bg-fg-3",
  success: "bg-profit",
  error: "bg-risk",
  info: "bg-info",
};

/** Minimal toaster: bottom-right stack, polite live region, auto-dismiss. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const reduce = useReducedMotion();

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback<ToastApi["toast"]>(
    ({ title, description, tone = "neutral", durationMs = 4200 }) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { id, title, description, tone }]);
      window.setTimeout(() => dismiss(id), durationMs);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite" aria-atomic={false} className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2 max-md:bottom-20">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              layout={!reduce}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: 16 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              role={t.tone === "error" ? "alert" : "status"}
              className="pointer-events-auto flex items-start gap-2.5 rounded-md bg-surface-2 px-3.5 py-3 shadow-3 ring-1 ring-inset ring-line-strong"
            >
              <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", dot[t.tone])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-fg">{t.title}</p>
                {t.description ? <p className="mt-0.5 text-xs leading-5 text-fg-3">{t.description}</p> : null}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} className="-mr-1 grid size-5 shrink-0 place-items-center rounded-xs text-fg-3 hover:text-fg" aria-label="Dismiss">
                <svg viewBox="0 0 16 16" className="size-3" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) return { toast: () => {} };
  return ctx;
}
