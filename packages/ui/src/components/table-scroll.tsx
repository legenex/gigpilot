"use client";

import { useEffect, useRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/**
 * Horizontal scroll container that reports overflow state as data attributes
 * (`data-overflow-left` / `data-overflow-right`) so CSS can draw edge fade
 * masks only while there is more table to scroll to.
 */
export function TableScroll({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.toggleAttribute("data-overflow-left", el.scrollLeft > 1);
      el.toggleAttribute("data-overflow-right", max > 1 && el.scrollLeft < max - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const table = el.firstElementChild;
    if (table) ro.observe(table);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);
  return (
    <div ref={ref} className={cn("gp-scroll-fade", className)} {...props}>
      {children}
    </div>
  );
}
