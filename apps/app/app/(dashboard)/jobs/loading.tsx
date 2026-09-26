import { Skeleton } from "@gigpilot/ui";

export default function Loading() {
  return (
    <div className="page" aria-busy aria-label="Loading jobs">
      <Skeleton className="mb-2 h-3 w-16" />
      <Skeleton className="mb-2 h-7 w-96 max-w-full" />
      <Skeleton className="mb-6 h-4 w-96 max-w-full" />
      <Skeleton className="mb-5 h-14 w-full" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex h-11 items-center gap-4 border-b border-line">
          <Skeleton className="h-3 w-72" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="ml-auto h-3 w-40" />
        </div>
      ))}
    </div>
  );
}
