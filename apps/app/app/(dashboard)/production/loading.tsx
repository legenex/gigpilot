import { Skeleton } from "@gigpilot/ui";

export default function Loading() {
  return (
    <div className="page" aria-busy aria-label="Loading production">
      <Skeleton className="mb-2 h-3 w-20" />
      <Skeleton className="mb-2 h-7 w-80 max-w-full" />
      <Skeleton className="mb-6 h-4 w-96 max-w-full" />
      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    </div>
  );
}
