import { describe, expect, it } from "vitest";
import { createEmptyBranches, hydrateBranchesFromNodes, normalizeBranches, type SequenceBranch } from "./sequenceBranches";

describe("sequenceBranches", () => {
  it("hydrates legacy sequence steps into branch A and leaves branch B empty", () => {
    const branches = hydrateBranchesFromNodes([], [
      { id: "step-1", step_order: 1, channel: "email", body: "hello", delay_hours: 24 },
      { id: "step-2", step_order: 2, channel: "sms", body: "ping", delay_hours: 48 },
    ]);

    expect(branches[0].id).toBe("branch_a");
    expect(branches[0].steps).toHaveLength(2);
    expect(branches[1].id).toBe("branch_b");
    expect(branches[1].steps).toHaveLength(0);
    expect(branches[0].steps[0].actions[0].channel).toBe("email");
  });

  it("keeps explicit branch metadata when hydrating nodes", () => {
    const branches = hydrateBranchesFromNodes([
      {
        id: "node-b",
        node_order: 2,
        branch_id: "branch_b",
        branch_step_order: 1,
        label: "B lane",
        sequence_actions: [{ id: "action-b", channel: "sms", message_body: "branch b" }],
      },
      {
        id: "node-a",
        node_order: 1,
        branch_id: "branch_a",
        branch_step_order: 1,
        label: "A lane",
        sequence_actions: [{ id: "action-a", channel: "email", message_body: "branch a" }],
      },
    ]);

    expect(branches[0].steps[0].label).toBe("A lane");
    expect(branches[1].steps[0].label).toBe("B lane");
    expect(branches[1].steps[0].branchId).toBe("branch_b");
  });

  it("normalizes branch ordering and guarantees both branches", () => {
    const branches = normalizeBranches([
      {
        id: "branch_b",
        label: "Branch B",
        steps: [{ id: "b1", label: "", branchId: "branch_b", branchStepOrder: 7, nodeOrder: 9, actions: [] }],
      },
    ] satisfies Partial<SequenceBranch>[]);

    expect(branches).toHaveLength(2);
    expect(branches[0].id).toBe("branch_a");
    expect(branches[1].steps[0].branchStepOrder).toBe(1);
  });

  it("creates two empty branches for a new sequence", () => {
    const branches = createEmptyBranches();
    expect(branches.map((branch) => branch.id)).toEqual(["branch_a", "branch_b"]);
    expect(branches.every((branch) => branch.steps.length === 0)).toBe(true);
  });
});
