import { Skeleton } from "@gigpilot/ui";

export default function Loading() {
  return (
    <div className="page" aria-busy aria-label="Loading markets">
      <Skeleton className="mb-2 h-3 w-24" />
      <Skeleton className="mb-2 h-7 w-96 max-w-full" />
      <Skeleton className="mb-8 h-4 w-[420px] max-w-full" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex h-14 items-center gap-4 border-b border-line">
          <Skeleton className="h-4 w-8" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-2 w-36" />
          <Skeleton className="ml-auto h-3 w-64" />
        </div>
      ))}
    </div>
  );
}
