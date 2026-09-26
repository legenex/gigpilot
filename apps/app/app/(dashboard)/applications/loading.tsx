import { Skeleton } from "@gigpilot/ui";

export default function Loading() {
  return (
    <div className="page" aria-busy aria-label="Loading applications">
      <Skeleton className="mb-2 h-3 w-24" />
      <Skeleton className="mb-2 h-7 w-96 max-w-full" />
      <Skeleton className="mb-6 h-4 w-80 max-w-full" />
      <Skeleton className="mb-5 h-14 w-full" />
      <div className="flex gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex w-[272px] flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
