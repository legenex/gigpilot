"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@gigpilot/ui/lib/cn";

/**
 * Defers mounting (and therefore downloading) a heavy client visual until it
 * is about to scroll into view. The placeholder reserves the same box, so
 * nothing shifts when the real component arrives.
 */
export function LazyMount({ children, className, placeholder, margin = "600px 0px" }: { children: ReactNode; className?: string; placeholder?: ReactNode; margin?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setShow(true);
          io.disconnect();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return (
    <div ref={ref} className={cn("relative", className)}>
      {show ? children : placeholder}
    </div>
  );
}

export function FramePlaceholder({ className, label }: { className?: string; label?: string }) {
  return (
    <div className={cn("product-frame flex items-center justify-center", className)} aria-hidden>
      <span className="label">{label ?? "Loading"}</span>
    </div>
  );
}
