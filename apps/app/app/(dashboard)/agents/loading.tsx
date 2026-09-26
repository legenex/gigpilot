import { Skeleton } from "@gigpilot/ui";

export default function Loading() {
  return (
    <div className="page" aria-busy aria-label="Loading agents">
      <Skeleton className="mb-2 h-3 w-16" />
      <Skeleton className="mb-2 h-7 w-64" />
      <Skeleton className="mb-6 h-4 w-96 max-w-full" />
      <div className="mb-7 grid grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-none" />
        ))}
      </div>
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="flex h-9 items-center gap-4 border-b border-line">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-64" />
          <Skeleton className="ml-auto h-3 w-24" />
        </div>
      ))}
    </div>
  );
}
