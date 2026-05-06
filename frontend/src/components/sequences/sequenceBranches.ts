import type { ActionData } from "./ActionNode";

export type SequenceBranchId = "branch_a" | "branch_b";

export interface BranchStepData {
  id: string;
  label: string;
  actions: ActionData[];
  branchId: SequenceBranchId;
  branchStepOrder: number;
  nodeOrder: number;
}

export interface SequenceBranch {
  id: SequenceBranchId;
  label: string;
  steps: BranchStepData[];
}

interface NodeRowLike {
  id: string;
  node_order?: number | null;
  label?: string | null;
  branch_id?: string | null;
  branch_step_order?: number | null;
  sequence_actions?: Array<Record<string, unknown>> | null;
}

interface SequenceStepLike {
  id: string;
  step_order?: number | null;
  channel?: string | null;
  step_type?: string | null;
  body?: string | null;
  delay_hours?: number | null;
  min_hours_after_connection?: number | null;
}

const BRANCH_META: Record<SequenceBranchId, { label: string; sortOrder: number }> = {
  branch_a: { label: "Branch A", sortOrder: 0 },
  branch_b: { label: "Branch B", sortOrder: 1 },
};

export function getBranchLabel(branchId: SequenceBranchId) {
  return BRANCH_META[branchId].label;
}

export function createDefaultAction(): ActionData {
  return {
    id: crypto.randomUUID(),
    channel: "email",
    messageBody: "",
    baseDelayHours: 24,
    delayIntervalMinutes: 0,
    jiggleMinutes: 10,
    postConnectionHardcodedHours: 4,
    respectSendWindow: true,
    useSignature: true,
  };
}

export function createEmptyBranches(): SequenceBranch[] {
  return [
    { id: "branch_a", label: getBranchLabel("branch_a"), steps: [] },
    { id: "branch_b", label: getBranchLabel("branch_b"), steps: [] },
  ];
}

export function createBranchStep(branchId: SequenceBranchId, branchStepOrder: number): BranchStepData {
  return {
    id: crypto.randomUUID(),
    label: "",
    actions: [createDefaultAction()],
    branchId,
    branchStepOrder,
    nodeOrder: branchStepOrder,
  };
}

function mapActionRow(action: Record<string, unknown>): ActionData {
  return {
    id: typeof action.id === "string" ? action.id : crypto.randomUUID(),
    channel: typeof action.channel === "string"
      ? action.channel
      : typeof action.step_type === "string"
        ? action.step_type
        : "email",
    messageBody: typeof action.message_body === "string"
      ? action.message_body
      : typeof action.body === "string"
        ? action.body
        : "",
    baseDelayHours: Number(action.base_delay_hours ?? action.delay_hours) || 0,
    delayIntervalMinutes: Number(action.delay_interval_minutes) || 0,
    jiggleMinutes: Number(action.jiggle_minutes) || 0,
    postConnectionHardcodedHours: Number(action.post_connection_hardcoded_hours ?? action.min_hours_after_connection) || 4,
    respectSendWindow: action.respect_send_window !== false,
    useSignature: action.use_signature !== false,
    attachmentUrl: typeof action.attachment_url === "string" ? action.attachment_url : undefined,
    attachmentName: typeof action.attachment_name === "string" ? action.attachment_name : undefined,
  };
}

function normalizeBranchId(value: unknown): SequenceBranchId | null {
  return value === "branch_a" || value === "branch_b" ? value : null;
}

function sortSteps(a: BranchStepData, b: BranchStepData) {
  if (a.branchId !== b.branchId) {
    return BRANCH_META[a.branchId].sortOrder - BRANCH_META[b.branchId].sortOrder;
  }
  return (a.branchStepOrder || a.nodeOrder) - (b.branchStepOrder || b.nodeOrder);
}

export function normalizeBranches(branches?: SequenceBranch[]): SequenceBranch[] {
  const incoming = branches && branches.length > 0 ? branches : createEmptyBranches();
  const map = new Map<SequenceBranchId, SequenceBranch>();

  for (const branchId of ["branch_a", "branch_b"] as const) {
    const source = incoming.find((branch) => branch.id === branchId);
    map.set(branchId, {
      id: branchId,
      label: getBranchLabel(branchId),
      steps: (source?.steps || []).map((step) => ({
        ...step,
        branchId,
      })),
    });
  }

  let globalOrder = 1;
  return (["branch_a", "branch_b"] as const).map((branchId) => {
    const branch = map.get(branchId)!;
    const steps = [...branch.steps]
      .sort(sortSteps)
      .map((step, index) => ({
        ...step,
        branchId,
        branchStepOrder: index + 1,
        nodeOrder: globalOrder++,
      }));

    return {
      ...branch,
      steps,
    };
  });
}

export function hydrateBranchesFromNodes(nodeRows?: NodeRowLike[] | null, sequenceSteps?: SequenceStepLike[] | null): SequenceBranch[] {
  if (nodeRows && nodeRows.length > 0) {
    const hasExplicitBranching = nodeRows.some((node) => normalizeBranchId(node.branch_id));
    const rawSteps: BranchStepData[] = [...nodeRows]
      .sort((a, b) => (a.node_order || 0) - (b.node_order || 0))
      .map((node, index) => ({
        id: node.id,
        label: node.label || "",
        branchId: hasExplicitBranching ? (normalizeBranchId(node.branch_id) || "branch_a") : "branch_a",
        branchStepOrder: Number(node.branch_step_order) || index + 1,
        nodeOrder: Number(node.node_order) || index + 1,
        actions: (node.sequence_actions || []).map(mapActionRow),
      }));

    return normalizeBranches(
      createEmptyBranches().map((branch) => ({
        ...branch,
        steps: rawSteps.filter((step) => step.branchId === branch.id),
      })),
    );
  }

  if (sequenceSteps && sequenceSteps.length > 0) {
    return normalizeBranches([
      {
        id: "branch_a",
        label: getBranchLabel("branch_a"),
        steps: [...sequenceSteps]
          .sort((a, b) => (a.step_order || 0) - (b.step_order || 0))
          .map((step, index) => ({
            id: step.id,
            label: `Step ${index + 1}`,
            branchId: "branch_a" as const,
            branchStepOrder: index + 1,
            nodeOrder: index + 1,
            actions: [mapActionRow(step)],
          })),
      },
      { id: "branch_b", label: getBranchLabel("branch_b"), steps: [] },
    ]);
  }

  return createEmptyBranches();
}

export function flattenBranchSteps(branches: SequenceBranch[]): BranchStepData[] {
  return normalizeBranches(branches).flatMap((branch) => branch.steps);
}

export function getBranchStats(branches: SequenceBranch[]) {
  const normalized = normalizeBranches(branches);
  const actionsPerBranch: Record<SequenceBranchId, number> = {
    branch_a: 0,
    branch_b: 0,
  };
  const channelCounts: Record<string, number> = {};
  let totalActions = 0;

  for (const branch of normalized) {
    for (const step of branch.steps) {
      const count = step.actions?.length || 0;
      actionsPerBranch[branch.id] += count;
      totalActions += count;
      for (const action of step.actions || []) {
        channelCounts[action.channel] = (channelCounts[action.channel] || 0) + 1;
      }
    }
  }

  return { actionsPerBranch, channelCounts, totalActions };
}

export function compareSequenceNodes(
  a: { branch_id?: string | null; branch_step_order?: number | null; node_order?: number | null },
  b: { branch_id?: string | null; branch_step_order?: number | null; node_order?: number | null },
) {
  const branchA = normalizeBranchId(a?.branch_id);
  const branchB = normalizeBranchId(b?.branch_id);

  if (branchA && branchB && branchA !== branchB) {
    return BRANCH_META[branchA].sortOrder - BRANCH_META[branchB].sortOrder;
  }

  if (branchA && branchB) {
    return (Number(a?.branch_step_order) || Number(a?.node_order) || 0) - (Number(b?.branch_step_order) || Number(b?.node_order) || 0);
  }

  return (Number(a?.node_order) || 0) - (Number(b?.node_order) || 0);
}
