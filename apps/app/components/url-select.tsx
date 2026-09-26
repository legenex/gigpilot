"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@gigpilot/ui";

/** Select bound to a URL search param (filters stay shareable and survive refresh). */
export function UrlSelect({ param, value, options, label, className }: { param: string; value: string; options: { value: string; label: string }[]; label: string; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, start] = useTransition();
  return (
    <Select
      aria-label={label}
      value={value}
      className={className}
      onChange={(e) => {
        const sp = new URLSearchParams(params.toString());
        if (e.target.value) sp.set(param, e.target.value);
        else sp.delete(param);
        start(() => router.replace(sp.toString() ? `${pathname}?${sp}` : pathname, { scroll: false }));
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
