import { describe, it, expect } from "vitest";
import {
  CANONICAL_PIPELINE,
  canonicalConfig,
  nextStage,
  prevStage,
  stageOrder,
  stageToCanonical,
  type CanonicalStage,
} from "./pipeline";

// pipeline.ts is the spine of the kanban, the To-Do widget, the
// sequence engine's stage transitions, and the move-stage mutation.
// A regression in any of these helpers cascades wide — these tests
// are cheap insurance.

describe("stageToCanonical", () => {
  it("returns null for empty / null / undefined", () => {
    expect(stageToCanonical(null)).toBeNull();
    expect(stageToCanonical(undefined)).toBeNull();
    expect(stageToCanonical("")).toBeNull();
  });

  it("returns null for unknown values", () => {
    expect(stageToCanonical("not-a-stage")).toBeNull();
    expect(stageToCanonical("PITCH")).toBeNull(); // case-sensitive
  });

  it("maps every CANONICAL_PIPELINE alias back to its canonical key", () => {
    for (const stage of CANONICAL_PIPELINE) {
      for (const alias of stage.pipelineStageValues) {
        expect(stageToCanonical(alias)).toBe(stage.key);
      }
    }
  });

  it("handles the legacy raw values from send_outs.stage_check", () => {
    // Critical because PR #144 widened the candidates_job_status_check
    // constraint to accept these — they need to round-trip through
    // stageToCanonical without dropping rows from the kanban.
    expect(stageToCanonical("send_out")).toBe("ready_to_send");
    expect(stageToCanonical("sendout")).toBe("ready_to_send");
    expect(stageToCanonical("ready_to_send")).toBe("ready_to_send");
    expect(stageToCanonical("pitch")).toBe("pitch");
    expect(stageToCanonical("pitched")).toBe("pitch");
    expect(stageToCanonical("submitted")).toBe("submitted");
    expect(stageToCanonical("sent")).toBe("submitted");
  });
});

describe("canonicalConfig", () => {
  it("returns the config for every canonical key", () => {
    for (const stage of CANONICAL_PIPELINE) {
      const cfg = canonicalConfig(stage.key);
      expect(cfg).toBe(stage);
      expect(cfg.label).toBeTruthy();
      expect(cfg.shortLabel).toBeTruthy();
      expect(cfg.color).toBeTruthy();
      expect(cfg.dotColor).toBeTruthy();
    }
  });
});

describe("stageOrder", () => {
  it("returns a 0-based index for every canonical stage", () => {
    expect(stageOrder("pitch")).toBe(0);
    expect(stageOrder("ready_to_send")).toBe(1);
    expect(stageOrder("submitted")).toBe(2);
  });

  it("returns -1 for unknown stages", () => {
    expect(stageOrder("garbage" as CanonicalStage)).toBe(-1);
  });

  it("orders stages monotonically", () => {
    const orders = CANONICAL_PIPELINE.map((s) => stageOrder(s.key));
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThan(orders[i - 1]);
    }
  });
});

describe("nextStage / prevStage", () => {
  it("nextStage advances forward through the funnel", () => {
    expect(nextStage("pitch")).toBe("ready_to_send");
    expect(nextStage("ready_to_send")).toBe("submitted");
  });

  it("nextStage returns null at the end of the funnel", () => {
    const last = CANONICAL_PIPELINE[CANONICAL_PIPELINE.length - 1].key;
    expect(nextStage(last)).toBeNull();
  });

  it("prevStage steps back through the funnel", () => {
    expect(prevStage("ready_to_send")).toBe("pitch");
    expect(prevStage("submitted")).toBe("ready_to_send");
  });

  it("prevStage returns null at the start", () => {
    expect(prevStage("pitch")).toBeNull();
  });

  it("nextStage(prevStage(x)) === x for middle stages — round trip", () => {
    for (let i = 1; i < CANONICAL_PIPELINE.length - 1; i++) {
      const k = CANONICAL_PIPELINE[i].key;
      expect(nextStage(prevStage(k)!)).toBe(k);
    }
  });
});
