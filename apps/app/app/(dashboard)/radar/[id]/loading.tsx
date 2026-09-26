import { Skeleton } from "@gigpilot/ui";

export default function Loading() {
  return (
    <div className="page" aria-busy aria-label="Loading opportunity">
      <Skeleton className="mb-5 h-3 w-36" />
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-3 w-64" />
          <Skeleton className="h-7 w-3/4" />
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
        <Skeleton className="h-80 w-full" />
      </div>
    </div>
  );
}
