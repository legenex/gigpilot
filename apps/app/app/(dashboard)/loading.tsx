import { Skeleton } from "@gigpilot/ui";

export default function Loading() {
  return (
    <div className="page" aria-busy aria-label="Loading">
      <Skeleton className="mb-2 h-3 w-40" />
      <Skeleton className="mb-2 h-7 w-80 max-w-full" />
      <Skeleton className="mb-6 h-4 w-[480px] max-w-full" />
      <Skeleton className="mb-6 h-40 w-full" />
      <Skeleton className="mb-6 h-20 w-full" />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
