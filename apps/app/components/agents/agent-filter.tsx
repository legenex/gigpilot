"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AGENTS } from "@gigpilot/contracts";
import { Select } from "@gigpilot/ui";

export function AgentFilter({ value }: { value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <Select
      aria-label="Filter by agent"
      value={value}
      className="w-[200px]"
      onChange={(e) => {
        const sp = new URLSearchParams(params.toString());
        if (e.target.value) sp.set("agent", e.target.value);
        else sp.delete("agent");
        router.replace(sp.toString() ? `${pathname}?${sp}` : pathname, { scroll: false });
      }}
    >
      <option value="">All agents</option>
      {Object.entries(AGENTS).map(([k, a]) => (
        <option key={k} value={k}>
          {a.name}
        </option>
      ))}
    </Select>
  );
}
