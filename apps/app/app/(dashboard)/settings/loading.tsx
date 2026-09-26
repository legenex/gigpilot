import { Skeleton } from "@gigpilot/ui";

export default function Loading() {
  return (
    <div className="page" aria-busy aria-label="Loading settings">
      <Skeleton className="mb-2 h-3 w-16" />
      <Skeleton className="mb-2 h-7 w-72" />
      <Skeleton className="mb-8 h-4 w-96 max-w-full" />
      <div className="grid gap-10 lg:grid-cols-[180px_1fr]">
        <div className="hidden flex-col gap-2 lg:flex">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-32" />
          ))}
        </div>
        <div className="flex max-w-[880px] flex-col gap-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
