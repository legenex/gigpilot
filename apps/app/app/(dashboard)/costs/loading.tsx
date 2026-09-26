import { Skeleton } from "@gigpilot/ui";

export default function Loading() {
  return (
    <div className="page" aria-busy aria-label="Loading costs">
      <Skeleton className="mb-2 h-3 w-16" />
      <Skeleton className="mb-2 h-7 w-80 max-w-full" />
      <Skeleton className="mb-6 h-4 w-[460px] max-w-full" />
      <Skeleton className="mb-7 h-20 w-full" />
      <div className="grid gap-8 xl:grid-cols-[1.5fr_1fr]">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
