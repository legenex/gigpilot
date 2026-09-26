import { Skeleton } from "@gigpilot/ui";

export default function Loading() {
  return (
    <div className="page" aria-busy aria-label="Loading integrations">
      <Skeleton className="mb-2 h-3 w-24" />
      <Skeleton className="mb-2 h-7 w-80 max-w-full" />
      <Skeleton className="mb-7 h-4 w-96 max-w-full" />
      <Skeleton className="mb-7 h-12 w-full" />
      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-56 w-full" />
        ))}
      </div>
    </div>
  );
}
