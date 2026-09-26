import type { ReactNode } from "react";
import { cn } from "@gigpilot/ui";

/**
 * Section opener: a hairline "calibrated tape" with a mono index, the section
 * name and the loop stage it belongs to. This is the site's structural motif —
 * sections are separated by instruments, not boxes.
 */
export function SectionRule({ index, name, stage }: { index: string; name: string; stage?: string }) {
  return (
    <div className="flex items-center gap-4 border-t border-line pt-3" aria-hidden>
      <span className="label tnum text-fg">{index}</span>
      <span className="label">{name}</span>
      <span className="ruler mt-[1px] hidden flex-1 self-start opacity-50 sm:block" />
      {stage && <span className="label ml-auto sm:ml-0">{stage}</span>}
    </div>
  );
}

export function Section({
  id,
  index,
  name,
  stage,
  children,
  className,
  labelledBy,
}: {
  id: string;
  index: string;
  name: string;
  stage?: string;
  children: ReactNode;
  className?: string;
  labelledBy: string;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn("relative pb-4 pt-24 sm:pt-28 lg:pt-32", className)}>
      <div className="site-container">
        <SectionRule index={index} name={name} stage={stage} />
        {children}
      </div>
    </section>
  );
}

/** Two-column intro: headline left, lead + supporting detail right. `center` stacks it on the axis. */
export function SectionIntro({
  id,
  title,
  lead,
  aside,
  className,
  center,
}: {
  id: string;
  title: ReactNode;
  lead: ReactNode;
  aside?: ReactNode;
  className?: string;
  center?: boolean;
}) {
  if (center) {
    return (
      <div className={cn("mx-auto mt-10 max-w-[900px] text-left sm:text-center lg:mt-16", className)}>
        <h2 id={id} className="display-2 reveal">
          {title}
        </h2>
        <p className="reveal-late mx-auto mt-6 max-w-[660px] text-[17px] leading-[28px] text-fg-2 lg:text-lead">{lead}</p>
        {aside}
      </div>
    );
  }
  return (
    <div className={cn("mt-10 grid gap-6 lg:mt-14 lg:grid-cols-12 lg:gap-6", className)}>
      <h2 id={id} className="display-2 reveal lg:col-span-6">
        {title}
      </h2>
      <div className="reveal-late lg:col-span-5 lg:col-start-8 lg:pt-2">
        <p className="text-[17px] leading-[28px] text-fg-2 lg:text-lead">{lead}</p>
        {aside}
      </div>
    </div>
  );
}
