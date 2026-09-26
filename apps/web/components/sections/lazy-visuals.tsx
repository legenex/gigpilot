"use client";

import dynamic from "next/dynamic";
import { FramePlaceholder, LazyMount } from "@/components/motion/lazy-mount";
import type { Preset } from "./profit-calculator";

const ProfitCalculator = dynamic(() => import("./profit-calculator").then((m) => m.ProfitCalculator), {
  ssr: false,
  loading: () => <FramePlaceholder className="h-[1040px] lg:h-[660px]" label="Calculator" />,
});
const WorkflowDag = dynamic(() => import("./workflow-dag").then((m) => m.WorkflowDag), {
  ssr: false,
  loading: () => <FramePlaceholder className="h-[900px] md:h-[720px] xl:h-[420px]" label="Workflow" />,
});
const RouterDiagram = dynamic(() => import("./routing-visual").then((m) => m.RouterDiagram), {
  ssr: false,
  loading: () => <div className="h-[420px]" />,
});
const CreativeBroker = dynamic(() => import("./routing-visual").then((m) => m.CreativeBroker), {
  ssr: false,
  loading: () => <FramePlaceholder className="h-[460px]" label="Broker" />,
});
const LearningChart = dynamic(() => import("./learning-chart").then((m) => m.LearningChart), {
  ssr: false,
  loading: () => <div className="h-[340px]" />,
});

export function LazyProfitCalculator({ presets }: { presets: Preset[] }) {
  return (
    <LazyMount placeholder={<FramePlaceholder className="h-[1040px] lg:h-[660px]" label="Calculator" />}>
      <ProfitCalculator presets={presets} />
    </LazyMount>
  );
}

export function LazyWorkflowDag() {
  return (
    <LazyMount placeholder={<FramePlaceholder className="h-[900px] md:h-[720px] xl:h-[420px]" label="Workflow" />}>
      <WorkflowDag />
    </LazyMount>
  );
}

export function LazyRouterDiagram() {
  return (
    <LazyMount placeholder={<div className="h-[420px]" />}>
      <RouterDiagram />
    </LazyMount>
  );
}

export function LazyCreativeBroker({ defaultThreshold }: { defaultThreshold: number }) {
  return (
    <LazyMount placeholder={<FramePlaceholder className="h-[460px]" label="Broker" />}>
      <CreativeBroker defaultThreshold={defaultThreshold} />
    </LazyMount>
  );
}

export function LazyLearningChart() {
  return (
    <LazyMount placeholder={<div className="h-[340px]" />}>
      <LearningChart />
    </LazyMount>
  );
}
