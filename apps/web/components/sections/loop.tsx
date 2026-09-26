import { Section, SectionIntro } from "@/components/site/section";
import { LoopRoute, type Waypoint } from "./loop-route";

const STAGES: Waypoint[] = [
  {
    code: "DSCVR",
    name: "Discover",
    body: "Pull permitted sources every 30 minutes. Normalise, de-duplicate, expire at 96 hours.",
    agent: "Opportunity Scout",
    state: "new",
  },
  { code: "ANLYS", name: "Analyse", body: "Extract deliverables, assets, risks and a probable workflow.", agent: "Opportunity Analyst", state: "analysing → analysed" },
  { code: "PRICE", name: "Price", body: "Compute cost, fees, contingency, shadow cost, profit and margin.", agent: "Economics", state: "→ shortlisted | rejected" },
  { code: "PRSUE", name: "Pursue", body: "You approve the shortlist, then the price and scope of each proposal.", agent: "Proposal · you", state: "pursuing → applied", owner: true },
  { code: "BUILD", name: "Build", body: "Compile the job into a workflow DAG and execute it inside spend limits.", agent: "Production Planner", state: "planning → executing" },
  { code: "VRIFY", name: "Verify", body: "Independent QA against the brief. Recovery repairs what fails.", agent: "QA Evaluator · Recovery", state: "qa ⇄ repairing" },
  { code: "DLVER", name: "Deliver", body: "Package files, notes and hand-off. You approve what ships.", agent: "Client · you", state: "awaiting_final_approval → delivered", owner: true },
  { code: "LEARN", name: "Learn", body: "Actual spend, quality and outcome update sourcing, routing and estimates.", agent: "Market Research", state: "closed" },
];

export function LoopSection() {
  return (
    <Section id="loop" index="01" name="The loop" stage="Discover → Learn" labelledBy="loop-title">
      <SectionIntro
        id="loop-title"
        title="One loop. Eight stages. Every job."
        lead="Each stage is owned by a specialist agent and every status change is an audited state transition. Nothing skips a stage, and nothing reaches a client without passing QA — and you."
      />
      <LoopRoute stages={STAGES} />
    </Section>
  );
}
