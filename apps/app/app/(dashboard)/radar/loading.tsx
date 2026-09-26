import { Skeleton } from "@gigpilot/ui";

export default function Loading() {
  return (
    <div className="page" aria-busy aria-label="Loading radar">
      <Skeleton className="mb-2 h-3 w-32" />
      <Skeleton className="mb-2 h-7 w-96 max-w-full" />
      <Skeleton className="mb-6 h-4 w-[520px] max-w-full" />
      <div className="mb-4 flex gap-2">
        <Skeleton className="h-8 w-80" />
      </div>
      <div className="mb-4 flex gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-44" />
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-md ring-1 ring-inset ring-line">
        {Array.from({ length: 14 }).map((_, i) => (
          <div key={i} className="flex h-9 items-center gap-4 px-3">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 flex-1" style={{ maxWidth: `${40 + ((i * 17) % 30)}%` }} />
            <Skeleton className="ml-auto h-3 w-14" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
