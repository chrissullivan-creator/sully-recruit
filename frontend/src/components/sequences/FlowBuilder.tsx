import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowDown, ArrowRight, ArrowUp, GitBranch, Plus, Trash2, Wand2 } from "lucide-react";
import type { ActionData } from "./ActionNode";
import { SequenceStepCard } from "./SequenceStepCard";
import {
  createBranchStep,
  createEmptyBranches,
  createDefaultAction,
  normalizeBranches,
  type BranchStepData,
  type SequenceBranch,
  type SequenceBranchId,
} from "./sequenceBranches";

export type { BranchStepData, SequenceBranch, SequenceBranchId } from "./sequenceBranches";

interface Props {
  initialBranches?: SequenceBranch[];
  onChange?: (branches: SequenceBranch[]) => void;
  onAskJoe?: (
    action: ActionData,
    stepNumber: number,
    stepLabel: string,
    previousMessages: Array<{ channel: string; body: string }>,
  ) => Promise<string>;
  /** Merge-vars dictionary for live preview. When set, every step's
   *  body summary renders with {{tags}} substituted to the chosen
   *  recipient's values (so the recruiter sees what each contact will
   *  actually receive). Updated by SequenceBuilder's "Preview as" picker. */
  previewMergeVars?: Record<string, string>;
}

function serializeSnapshot(branches?: SequenceBranch[]) {
  return JSON.stringify(normalizeBranches(branches));
}

function createQuickTemplate(): SequenceBranch[] {
  const branches = createEmptyBranches();

  branches[0].steps = [
    {
      ...createBranchStep("branch_a", 1),
      label: "Multi-channel outreach",
      actions: [
        {
          id: crypto.randomUUID(),
          channel: "linkedin_inmail",
          messageBody: "Hi {{first_name}}, I'm {{sender_name}} at Emerald Recruiting. I came across your profile and think you'd be a great fit for {{job_name}}. Open to a quick chat?",
          baseDelayHours: 0,
          delayIntervalMinutes: 0,
          jiggleMinutes: 5,
          postConnectionHardcodedHours: 4,
          respectSendWindow: true,
        },
        {
          id: crypto.randomUUID(),
          channel: "linkedin_connection",
          messageBody: "Hi {{first_name}}, would love to connect about a role I think you'd be interested in.",
          baseDelayHours: 0,
          delayIntervalMinutes: 0,
          jiggleMinutes: 8,
          postConnectionHardcodedHours: 4,
          respectSendWindow: false,
        },
        {
          id: crypto.randomUUID(),
          channel: "email",
          messageBody: "Hi {{first_name}},\n\nI'm {{sender_name}} at Emerald Recruiting. I'm working on {{job_name}} and think your background is a strong match.\n\nWould you be open to a quick 15-minute call this week?\n\nBest,\n{{sender_name}}",
          baseDelayHours: 0,
          delayIntervalMinutes: 5,
          jiggleMinutes: 8,
          postConnectionHardcodedHours: 4,
          respectSendWindow: true,
          useSignature: true,
        },
      ],
    },
    {
      ...createBranchStep("branch_a", 2),
      label: "Follow-up email",
      actions: [
        {
          ...createDefaultAction(),
          channel: "email",
          messageBody: "Hi {{first_name}},\n\nJust following up on my earlier note about {{job_name}}. Would love to chat if you're open to it.\n\nBest,\n{{sender_name}}",
          baseDelayHours: 24,
          delayIntervalMinutes: 0,
          jiggleMinutes: 15,
          useSignature: true,
        },
      ],
    },
  ];

  branches[1].steps = [
    {
      ...createBranchStep("branch_b", 1),
      label: "Text follow-up",
      actions: [
        {
          ...createDefaultAction(),
          channel: "sms",
          messageBody: "Hi {{first_name}}, this is {{sender_name}} from Emerald Recruiting. I sent you an email about a role and wanted to see if you might be open to a quick chat.",
          baseDelayHours: 2,
          delayIntervalMinutes: 0,
          jiggleMinutes: 10,
        },
      ],
    },
    {
      ...createBranchStep("branch_b", 2),
      label: "Call task",
      actions: [
        {
          ...createDefaultAction(),
          channel: "manual_call",
          messageBody: "",
          baseDelayHours: 48,
          delayIntervalMinutes: 0,
          jiggleMinutes: 0,
        },
      ],
    },
  ];

  return normalizeBranches(branches);
}

function BranchColumn({
  branch,
  onAddStep,
  onDeleteStep,
  onMoveStep,
  onLabelChange,
  onActionsChange,
  onAskJoe,
  previewMergeVars,
}: {
  branch: SequenceBranch;
  onAddStep: () => void;
  onDeleteStep: (stepId: string) => void;
  onMoveStep: (stepId: string, direction: "up" | "down") => void;
  onLabelChange: (stepId: string, label: string) => void;
  onActionsChange: (stepId: string, actions: ActionData[]) => void;
  onAskJoe?: (stepId: string, actionIndex: number, action: ActionData, stepNumber: number, stepLabel: string) => Promise<string>;
  previewMergeVars?: Record<string, string>;
}) {
  return (
    <Card className="bg-slate-50/60 border-slate-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Steps</CardTitle>
            <p className="text-sm text-muted-foreground">
              {branch.steps.length === 0 ? "No steps yet" : `${branch.steps.length} step${branch.steps.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onAddStep}>
            <Plus className="h-3 w-3 mr-1" /> Add Step
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {branch.steps.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-muted-foreground">
            This lane is empty. Add a step to build the branch.
          </div>
        ) : (
          branch.steps.map((step, index) => (
            <div key={step.id} className="space-y-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <GitBranch className="h-3.5 w-3.5" />
                <span>Step {index + 1}</span>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-3">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => onMoveStep(step.id, "up")}
                    disabled={index === 0}
                    aria-label={`Move ${branch.label} step ${index + 1} up`}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => onMoveStep(step.id, "down")}
                    disabled={index === branch.steps.length - 1}
                    aria-label={`Move ${branch.label} step ${index + 1} down`}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => onDeleteStep(step.id)}
                    aria-label={`Delete ${branch.label} step ${index + 1}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <SequenceStepCard
                  label=""
                  actions={step.actions}
                  stepNumber={index + 1}
                  title={`Step ${index + 1}`}
                  onUpdate={(actions) => onActionsChange(step.id, actions)}
                  onAskJoe={
                    onAskJoe
                      ? (actionIndex, action, stepNumber, stepLabel) =>
                          onAskJoe(step.id, actionIndex, action, stepNumber, stepLabel)
                      : undefined
                  }
                  previewMergeVars={previewMergeVars}
                />
              </div>

              {index < branch.steps.length - 1 && (
                <div className="flex items-center justify-center text-muted-foreground">
                  <ArrowDown className="h-4 w-4" />
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function FlowBuilder({ initialBranches, onChange, onAskJoe, previewMergeVars }: Props) {
  // Initial state computed once. The earlier `useMemo([initialBranches])` made
  // a new memo object on every parent render, but the value was only used
  // for the initial useState seed — wasted work + churn.
  const [branches, setBranches] = useState<SequenceBranch[]>(() =>
    normalizeBranches(initialBranches),
  );

  // Refs so callbacks below stay stable and don't pull onChange/onAskJoe
  // into effect deps (which would re-fire the bidirectional sync loop
  // that was making the builder feel choppy / flashy).
  const onChangeRef = useRef(onChange);
  const onAskJoeRef = useRef(onAskJoe);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onAskJoeRef.current = onAskJoe; }, [onAskJoe]);

  // External-sync: only re-seed local state when the parent actually pushed a
  // *different* tree (e.g. after a fresh hydrate from the DB). Compare the
  // last serialized snapshot we received from the parent — not local — so we
  // don't ping-pong with our own changes.
  const lastIncomingRef = useRef(serializeSnapshot(initialBranches));
  useEffect(() => {
    const incoming = serializeSnapshot(initialBranches);
    if (incoming !== lastIncomingRef.current) {
      lastIncomingRef.current = incoming;
      setBranches(normalizeBranches(initialBranches));
    }
  }, [initialBranches]);

  // Single mutator: applies the update, normalises, and synchronously
  // notifies the parent. No more setState→effect→onChange→parentSetState
  // round-trip. Edits feel immediate.
  const updateBranch = useCallback(
    (branchId: SequenceBranchId, updater: (steps: BranchStepData[]) => BranchStepData[]) => {
      setBranches((current) => {
        const normalized = normalizeBranches(
          current.map((branch) =>
            branch.id === branchId
              ? { ...branch, steps: updater(branch.steps) }
              : branch,
          ),
        );
        // Cache the snapshot we're about to push so the external-sync
        // effect doesn't see our own write as an "incoming" change and
        // bounce it back.
        lastIncomingRef.current = serializeSnapshot(normalized);
        onChangeRef.current?.(normalized);
        return normalized;
      });
    },
    [],
  );

  const addStep = useCallback((branchId: SequenceBranchId) => {
    updateBranch(branchId, (steps) => [...steps, createBranchStep(branchId, steps.length + 1)]);
  }, [updateBranch]);

  const updateStepLabel = useCallback((branchId: SequenceBranchId, stepId: string, label: string) => {
    updateBranch(branchId, (steps) => steps.map((step) => (step.id === stepId ? { ...step, label } : step)));
  }, [updateBranch]);

  const updateStepActions = useCallback((branchId: SequenceBranchId, stepId: string, actions: ActionData[]) => {
    updateBranch(branchId, (steps) => steps.map((step) => (step.id === stepId ? { ...step, actions } : step)));
  }, [updateBranch]);

  const deleteStep = useCallback((branchId: SequenceBranchId, stepId: string) => {
    updateBranch(branchId, (steps) => steps.filter((step) => step.id !== stepId));
  }, [updateBranch]);

  const moveStep = useCallback((branchId: SequenceBranchId, stepId: string, direction: "up" | "down") => {
    updateBranch(branchId, (steps) => {
      const index = steps.findIndex((step) => step.id === stepId);
      if (index === -1) return steps;
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= steps.length) return steps;

      const next = [...steps];
      const [moved] = next.splice(index, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, [updateBranch]);

  const handleAskJoe = useCallback(async (
    branchId: SequenceBranchId,
    stepId: string,
    _actionIndex: number,
    action: ActionData,
    stepNumber: number,
    stepLabel: string,
  ): Promise<string> => {
    const handler = onAskJoeRef.current;
    if (!handler) return "";

    const branch = branches.find((candidate) => candidate.id === branchId);
    if (!branch) return "";

    const currentIndex = branch.steps.findIndex((step) => step.id === stepId);
    const previousMessages = branch.steps
      .slice(0, currentIndex)
      .flatMap((step) => (step.actions || []).filter((candidate) => candidate.messageBody))
      .map((candidate) => ({ channel: candidate.channel, body: candidate.messageBody }));

    return handler(action, stepNumber, stepLabel, previousMessages);
  }, [branches]);

  const loadQuickTemplate = useCallback(() => {
    setBranches(createQuickTemplate());
  }, []);

  return (
    <div className="space-y-6">
      <Card className="border-slate-200 bg-slate-50/40">
        <CardContent className="py-5">
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-full border border-slate-300 bg-white px-5 py-2 text-sm font-medium shadow-sm">
              Start
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <div className="h-px w-20 bg-slate-300" />
              <ArrowRight className="h-4 w-4" />
              <div className="h-px w-20 bg-slate-300" />
            </div>
            <div className="text-center text-sm text-muted-foreground">
              Every sequence starts here, then continues in exactly two fixed lanes.
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button variant="default" size="sm" onClick={loadQuickTemplate}>
          <Wand2 className="h-3 w-3 mr-1" /> Quick Template
        </Button>
      </div>

      {/* Single-lane linear view. The data model still carries branch_id
          for legacy compatibility, but the UI no longer surfaces the
          A/B split — every step lives on branch_a now. */}
      <div className="grid gap-6">
        {branches
          .filter((branch) => branch.id === "branch_a")
          .map((branch) => (
            <BranchColumn
              key={branch.id}
              branch={branch}
              onAddStep={() => addStep(branch.id)}
              onDeleteStep={(stepId) => deleteStep(branch.id, stepId)}
              onMoveStep={(stepId, direction) => moveStep(branch.id, stepId, direction)}
              onLabelChange={(stepId, label) => updateStepLabel(branch.id, stepId, label)}
              onActionsChange={(stepId, actions) => updateStepActions(branch.id, stepId, actions)}
              onAskJoe={(stepId, actionIndex, action, stepNumber, stepLabel) =>
                handleAskJoe(branch.id, stepId, actionIndex, action, stepNumber, stepLabel)
              }
              previewMergeVars={previewMergeVars}
            />
          ))}
      </div>

      <SchedulePreview branches={branches} />

      <SequenceWarnings branches={branches} />

      <div className="bg-white/90 backdrop-blur p-3 rounded-md shadow-sm border text-[10px] text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">Engine rules (automatic):</p>
        <p>&#8226; Any reply on any channel stops the sequence + Joe sentiment</p>
        <p>&#8226; Connection accepted does NOT stop (triggers LinkedIn message)</p>
        <p>&#8226; Calendar booked stops the sequence</p>
        <p>&#8226; LinkedIn message waits for connection (4h min, window-hours)</p>
        <p>&#8226; Email/SMS skipped if no email/phone on record</p>
        <p>&#8226; Delay hours count only within send window</p>
      </div>
    </div>
  );
}

/**
 * Cumulative-from-previous schedule preview. Walks the steps in order,
 * adding each action's wait (base_delay_hours + delay_interval_minutes)
 * to the running total. Mirrors the engine's cumulative logic in
 * sequenceEnrollmentInit so the editor preview matches what actually fires.
 */
function SchedulePreview({ branches }: { branches: SequenceBranch[] }) {
  const steps = flattenBranchSteps(branches);
  if (steps.length === 0) return null;

  let cumulativeMinutes = 0;
  const rows = steps.map((step, idx) => {
    const action = step.actions?.[0];
    const waitH = Number(action?.baseDelayHours) || 0;
    const waitM = Number(action?.delayIntervalMinutes) || 0;
    cumulativeMinutes += waitH * 60 + waitM;
    const channel = action?.channel || "—";
    const cumulativeLabel = formatCumulative(cumulativeMinutes);
    const waitLabel = idx === 0
      ? "fires at enrollment"
      : `+${waitH}h${waitM ? ` ${waitM}m` : ""} after step ${idx}`;
    return { idx: idx + 1, channel, waitLabel, cumulativeLabel };
  });

  return (
    <div className="bg-white/90 backdrop-blur p-3 rounded-md shadow-sm border text-[11px] space-y-1">
      <p className="font-medium text-foreground">Schedule preview (window-hours, cumulative):</p>
      {rows.map((r) => (
        <p key={r.idx} className="text-muted-foreground">
          <span className="font-mono">Step {r.idx}</span>{" "}
          <span className="capitalize">{r.channel.replace(/_/g, " ")}</span> —{" "}
          {r.waitLabel} <span className="text-foreground/70">({r.cumulativeLabel})</span>
        </p>
      ))}
    </div>
  );
}

function formatCumulative(minutes: number): string {
  if (minutes === 0) return "T+0";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `T+${m}m`;
  if (m === 0) return `T+${h}h`;
  return `T+${h}h ${m}m`;
}

/**
 * Editor-side guardrails. Currently flags the engine's hard rule that a
 * linkedin_message step needs a preceding linkedin_connection in the same
 * sequence — without it, the engine skips the message at fire time and
 * the recruiter sees a quiet failure.
 */
function SequenceWarnings({ branches }: { branches: SequenceBranch[] }) {
  const steps = flattenBranchSteps(branches);
  const warnings: string[] = [];

  let sawConnection = false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    for (const action of step.actions || []) {
      if (action.channel === "linkedin_connection") sawConnection = true;
      if (action.channel === "linkedin_message" && !sawConnection) {
        warnings.push(
          `Step ${i + 1}: LinkedIn message has no preceding connection request — the engine will skip it at fire time. Add a linkedin_connection step earlier.`,
        );
      }
    }
  }

  if (warnings.length === 0) return null;
  return (
    <div className="bg-amber-50 border border-amber-200 p-3 rounded-md text-[11px] space-y-1">
      <p className="font-medium text-amber-900">Heads up before you save:</p>
      {warnings.map((w, i) => (
        <p key={i} className="text-amber-800">&#8226; {w}</p>
      ))}
    </div>
  );
}
