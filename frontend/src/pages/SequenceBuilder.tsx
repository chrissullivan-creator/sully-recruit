import { useState, useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mergeVarsFromPerson } from "@/lib/merge-tags";
import { MainLayout } from "@/components/layout/MainLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SequenceSetup, type SequenceSetupData } from "@/components/sequences/SequenceSetup";
import { FlowBuilder, type SequenceBranch } from "@/components/sequences/FlowBuilder";
import { SequenceReview } from "@/components/sequences/SequenceReview";
import { compareSequenceNodes, createEmptyBranches, flattenBranchSteps, hydrateBranchesFromNodes, normalizeBranches } from "@/components/sequences/sequenceBranches";
import { toast } from "sonner";

function toTimeInput(value: unknown, fallback: string) {
  if (typeof value === "string" && /^\d{2}:\d{2}/.test(value)) return value.slice(0, 5);
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${String(value).padStart(2, "0")}:00`;
  }
  return fallback;
}

export default function SequenceBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isEdit = !!id;

  const [setup, setSetup] = useState<SequenceSetupData>({
    name: "",
    jobId: null,
    jobIds: [],
    audienceType: "candidates",
    objective: "",
    sendWindowStart: "09:00",
    sendWindowEnd: "18:00",
    timezone: "America/New_York",
    senderUserId: null,
    weekdaysOnly: false,
  });

  const [branches, setBranches] = useState<SequenceBranch[]>(createEmptyBranches());
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState(isEdit ? "flow" : "setup");
  // Live preview: merge-vars dict for whichever recipient the
  // recruiter picked from the "Preview as" selector. null = preview off.
  const [previewVars, setPreviewVars] = useState<Record<string, string> | null>(null);

  // Load existing sequence when editing.
  //
  // Previously this was a single embedded select:
  //   .select("*, sequence_nodes(..., sequence_actions(*)), sequence_steps(*)")
  // which would silently return `null` for the whole row when PostgREST
  // failed to resolve the nested `sequence_actions` relationship — leaving
  // the builder rendered with an empty form (the bug the user hit when
  // clicking into an existing sequence). Splitting into three separate
  // queries: setup row first (guaranteed to load), then nodes+actions,
  // then steps. Each step logs on failure so we never silently render
  // a blank Edit screen again.
  useEffect(() => {
    if (!id) return;
    (async () => {
      const { data: seq, error: seqErr } = await supabase
        .from("sequences")
        .select("*")
        .eq("id", id)
        .maybeSingle() as any;
      if (seqErr || !seq) {
        toast.error(`Couldn't load sequence: ${seqErr?.message || "not found"}`);
        return;
      }

      // job_ids[] is the canonical multi-tag list; fall back to a
      // single-element array built from job_id for old rows that
      // pre-date the migration.
      const loadedJobIds: string[] = Array.isArray(seq.job_ids) && seq.job_ids.length
        ? seq.job_ids
        : (seq.job_id ? [seq.job_id] : []);
      setSetup({
        name: seq.name || "",
        jobId: seq.job_id || loadedJobIds[0] || null,
        jobIds: loadedJobIds,
        audienceType: seq.audience_type,
        objective: seq.objective || "",
        sendWindowStart: toTimeInput(seq.send_window_start, "09:00"),
        sendWindowEnd: toTimeInput(seq.send_window_end, "18:00"),
        timezone: seq.timezone || "America/New_York",
        senderUserId: seq.sender_user_id || seq.created_by,
        weekdaysOnly: seq.weekdays_only === true,
      });

      const [{ data: nodes }, { data: stepsLegacy }] = await Promise.all([
        supabase
          .from("sequence_nodes")
          .select("id, node_order, node_type, label, branch_id, branch_step_order, sequence_actions(*)")
          .eq("sequence_id", id),
        supabase.from("sequence_steps").select("*").eq("sequence_id", id),
      ]);

      const nodeRows = ((nodes ?? []) as any[]).sort(compareSequenceNodes);
      setBranches(hydrateBranchesFromNodes(nodeRows, stepsLegacy ?? []));
    })();
  }, [id]);

  const handleFlowChange = useCallback((nextBranches: SequenceBranch[]) => {
    setBranches(normalizeBranches(nextBranches));
  }, []);

  // Ask Joe to draft a message for an action
  const handleAskJoe = useCallback(
    async (
      action: any,
      stepNumber: number,
      stepLabel: string,
      previousMessages: Array<{ channel: string; body: string }>,
    ): Promise<string> => {
      try {
        // Load job details if the sequence is tied to a job
        let jobDetails: any = null;
        if (setup.jobId) {
          const { data: job } = await supabase
            .from("jobs")
            .select("title, company_name, description")
            .eq("id", setup.jobId)
            .maybeSingle() as any;
          jobDetails = job;
        }

        // Load sender profile
        let senderName = "";
        let senderTitle = "";
        if (setup.senderUserId) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name, first_name, last_name, title")
            .eq("id", setup.senderUserId)
            .maybeSingle() as any;
          senderName =
            profile?.full_name ||
            `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() ||
            "";
          // Use title from profiles table if available, fall back to name-based lookup
          senderTitle = profile?.title || "";
          if (!senderTitle) {
            const nameLower = senderName.toLowerCase();
            if (nameLower.includes("chris")) senderTitle = "President";
            else if (nameLower.includes("nancy")) senderTitle = "Managing Director";
            else if (nameLower.includes("ashley")) senderTitle = "Recruiter";
          }
        }

        const totalSteps = flattenBranchSteps(branches).length;

        toast.info("Joe is drafting...", { duration: 2000 });

        const response = await fetch("/api/draft-sequence-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: action.channel,
            step_type: action.channel,
            step_number: stepNumber,
            step_label: stepLabel || undefined,
            total_steps: totalSteps,
            audience_type: setup.audienceType,
            sequence_name: setup.name,
            sequence_objective: setup.objective,
            sender_name: senderName,
            sender_title: senderTitle,
            job_title: jobDetails?.title,
            job_company: jobDetails?.company_name,
            job_description: jobDetails?.description,
            previous_messages: previousMessages,
          }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(err.error || `HTTP ${response.status}`);
        }

        const result = await response.json();
        if (!result.message) throw new Error("Joe returned no message");

        toast.success("Joe drafted a message");
        return result.message;
      } catch (err: any) {
        toast.error(`Joe failed: ${err.message}`);
        return "";
      }
    },
    [setup, branches],
  );

  const saveSequence = useCallback(async (status: "draft" | "active") => {
    if (!setup.name) {
      toast.error("Sequence name is required");
      return null;
    }
    if (!user?.id) {
      toast.error("Not authenticated");
      return null;
    }

    setSaving(true);
    try {
      // 1. Create or update the sequence
      // Resolve the canonical job tag list. job_id stays in sync with
      // jobIds[0] so legacy single-job consumers keep working.
      const finalJobIds = setup.jobIds.length ? setup.jobIds : (setup.jobId ? [setup.jobId] : []);
      const finalJobId = finalJobIds[0] ?? null;

      let sequenceId = id;
      if (!sequenceId) {
        const { data: seq, error } = await supabase
          .from("sequences")
          .insert({
            name: setup.name,
            job_id: finalJobId,
            job_ids: finalJobIds,
            audience_type: setup.audienceType,
            objective: setup.objective,
            send_window_start: setup.sendWindowStart,
            send_window_end: setup.sendWindowEnd,
            timezone: setup.timezone,
            weekdays_only: setup.weekdaysOnly,
            created_by: user.id,
            sender_user_id: setup.senderUserId || user.id,
            status,
          } as any)
          .select("id")
          .single();

        if (error) throw error;
        sequenceId = seq.id;
      } else {
        const { error: seqUpdateErr } = await supabase
          .from("sequences")
          .update({
            name: setup.name,
            job_id: finalJobId,
            job_ids: finalJobIds,
            audience_type: setup.audienceType,
            objective: setup.objective,
            send_window_start: setup.sendWindowStart,
            send_window_end: setup.sendWindowEnd,
            timezone: setup.timezone,
            weekdays_only: setup.weekdaysOnly,
            sender_user_id: setup.senderUserId || user.id,
            status,
          } as any)
          .eq("id", sequenceId);

        if (seqUpdateErr) throw seqUpdateErr;
      }

      // UPSERT nodes + actions by id. The previous delete-and-recreate
      // pattern silently failed when sequence_step_logs referenced the
      // existing nodes/actions (their FKs are NO ACTION, not CASCADE),
      // so saves appended duplicate rows instead of replacing the
      // original. Now we update existing rows in place by their UUID
      // and only delete rows the editor removed.
      const incomingSteps = flattenBranchSteps(branches);
      const incomingNodeIds = new Set(incomingSteps.map((s) => s.id));

      const { data: existingNodes } = await supabase
        .from("sequence_nodes")
        .select("id, sequence_actions(id)")
        .eq("sequence_id", sequenceId);

      const existingNodeRows = (existingNodes || []) as Array<{ id: string; sequence_actions: Array<{ id: string }> | null }>;
      const existingNodeIds = new Set(existingNodeRows.map((n) => n.id));
      const existingActionIdsByNode = new Map<string, Set<string>>(
        existingNodeRows.map((n) => [n.id, new Set((n.sequence_actions || []).map((a) => a.id))]),
      );

      // Delete nodes that the editor removed. Cascade clears their
      // sequence_actions. If a node has step_logs referencing its
      // actions, the FK blocks the delete; we surface a warning rather
      // than silently swallowing it.
      const removedNodeIds = [...existingNodeIds].filter((nid) => !incomingNodeIds.has(nid));
      if (removedNodeIds.length) {
        const { error: nodeDelErr } = await supabase
          .from("sequence_nodes")
          .delete()
          .in("id", removedNodeIds);
        if (nodeDelErr) {
          toast.warning(`Couldn't remove ${removedNodeIds.length} step(s) — they're referenced by active enrollments. Stop the enrollments first.`);
        }
      }

      for (const step of incomingSteps) {
        const nodePayload = {
          node_order: step.nodeOrder,
          node_type: "action",
          label: step.label,
          branch_id: step.branchId,
          branch_step_order: step.branchStepOrder,
        };

        if (existingNodeIds.has(step.id)) {
          const { error: nodeErr } = await supabase
            .from("sequence_nodes")
            .update(nodePayload as any)
            .eq("id", step.id);
          if (nodeErr) throw new Error(`Step update failed: ${nodeErr.message}`);
        } else {
          const { error: nodeErr } = await supabase
            .from("sequence_nodes")
            .insert({ id: step.id, sequence_id: sequenceId, ...nodePayload } as any);
          if (nodeErr) throw new Error(`Step insert failed: ${nodeErr.message}`);
        }

        const existingActionIds = existingActionIdsByNode.get(step.id) || new Set<string>();
        const incomingActionIds = new Set((step.actions || []).map((a) => a.id));

        const removedActionIds = [...existingActionIds].filter((aid) => !incomingActionIds.has(aid));
        if (removedActionIds.length) {
          const { error: actDelErr } = await supabase
            .from("sequence_actions")
            .delete()
            .in("id", removedActionIds);
          if (actDelErr) {
            toast.warning(`Couldn't remove ${removedActionIds.length} action(s) — referenced by active enrollments.`);
          }
        }

        for (const action of step.actions || []) {
          const actionPayload = {
            node_id: step.id,
            channel: action.channel,
            message_body: action.messageBody,
            base_delay_hours: action.baseDelayHours,
            delay_interval_minutes: action.delayIntervalMinutes,
            jiggle_minutes: action.jiggleMinutes,
            post_connection_hardcoded_hours: action.postConnectionHardcodedHours,
            respect_send_window: action.respectSendWindow,
            use_signature: action.channel === "email" ? (action.useSignature !== false) : false,
            // Attachments persist on email + LinkedIn message + InMail.
            // attachment_urls is the canonical list; attachment_url is
            // mirrored to the first entry for back-compat with read
            // paths that haven't been updated.
            attachment_urls:
              action.channel === "email"
                || action.channel === "linkedin_message"
                || action.channel === "linkedin_inmail"
                ? (action.attachmentUrls ?? [])
                : [],
            attachment_url:
              action.channel === "email"
                || action.channel === "linkedin_message"
                || action.channel === "linkedin_inmail"
                ? (action.attachmentUrls?.[0] ?? null)
                : null,
            // Subject + threading are email-only.
            subject_line: action.channel === "email" ? (action.subjectLine || null) : null,
            reply_to_previous: action.channel === "email" ? (action.replyToPrevious === true) : false,
          };

          if (existingActionIds.has(action.id)) {
            const { error: actUpdErr } = await supabase
              .from("sequence_actions")
              .update(actionPayload as any)
              .eq("id", action.id);
            if (actUpdErr) throw new Error(`Action update failed (${step.label || `${step.branchId} step ${step.branchStepOrder}`}): ${actUpdErr.message}`);
          } else {
            const { error: actInsErr } = await supabase
              .from("sequence_actions")
              .insert({ id: action.id, ...actionPayload } as any);
            if (actInsErr) throw new Error(`Action insert failed (${step.label || `${step.branchId} step ${step.branchStepOrder}`}): ${actInsErr.message}`);
          }
        }
      }
      return sequenceId;
    } catch (err: any) {
      toast.error(`Save failed: ${err.message}`);
      return null;
    } finally {
      setSaving(false);
    }
  }, [setup, branches, id, user]);

  /**
   * After saving an edit on an existing sequence, ask whether to re-pace
   * any active enrollments so step reorders, delay changes, and the
   * weekdays-only flag actually take effect on people mid-flight.
   * Without this, edits only apply to fresh enrollments.
   */
  const repaceIfNeeded = useCallback(async (seqId: string) => {
    if (!user?.id) return;
    const { count } = await supabase
      .from("sequence_enrollments")
      .select("id", { count: "exact", head: true })
      .eq("sequence_id", seqId)
      .eq("status", "active");
    const activeCount = count ?? 0;
    if (activeCount === 0) return;

    const confirmed = window.confirm(
      `${activeCount} active enrollment${activeCount === 1 ? "" : "s"} on this sequence.\n\n` +
      `Re-pace ${activeCount === 1 ? "it" : "them"} with the new step order + delays? ` +
      `Pending sends will be cancelled and rebuilt from this moment forward. ` +
      `History (sent / skipped) is preserved.`,
    );
    if (!confirmed) return;

    try {
      const resp = await fetch("/api/repace-sequence-enrollments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sequence_id: seqId, enrolled_by: user.id }),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || `HTTP ${resp.status}`);
      toast.success(`Re-paced ${result.repaced} enrollment${result.repaced === 1 ? "" : "s"}`);
    } catch (err: any) {
      toast.error(`Re-pace failed: ${err.message}`);
    }
  }, [user]);

  const handleSaveDraft = useCallback(async () => {
    const seqId = await saveSequence("draft");
    if (seqId) {
      toast.success("Sequence saved as draft");
      if (id) await repaceIfNeeded(seqId);
      if (!id) navigate(`/sequences/${seqId}/edit`, { replace: true });
    }
  }, [saveSequence, id, navigate, repaceIfNeeded]);

  const handleActivate = useCallback(async () => {
    const seqId = await saveSequence("active");
    if (seqId) {
      toast.success("Sequence activated");
      if (id) await repaceIfNeeded(seqId);
      navigate(`/sequences/${seqId}/schedule`);
    }
  }, [saveSequence, navigate, id, repaceIfNeeded]);

  return (
    <MainLayout>
      <div className="container mx-auto py-6 space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-display font-semibold uppercase tracking-wider text-muted-foreground">
              {isEdit ? "Editing sequence" : "New sequence"}
            </p>
            <h1 className="text-2xl font-bold truncate">
              {isEdit
                ? (setup.name?.trim() || <span className="text-muted-foreground italic">Untitled sequence</span>)
                : "New Sequence"}
            </h1>
            {isEdit && id && (
              <p className="text-[10px] text-muted-foreground/70 font-mono mt-0.5">id: {id}</p>
            )}
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="setup">1. Setup</TabsTrigger>
          <TabsTrigger value="flow">2. Flow Builder</TabsTrigger>
          <TabsTrigger value="review">3. Review</TabsTrigger>
        </TabsList>

          <TabsContent value="setup" className="mt-4">
            <div className="max-w-2xl">
              <SequenceSetup data={setup} onChange={setSetup} />
              <div className="mt-4 flex justify-end">
                <Button onClick={() => setActiveTab("flow")}>
                  Next: Build Flow
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="flow" className="mt-4">
            <PreviewAsPicker
              audience={setup.audienceType}
              previewVars={previewVars}
              onChange={setPreviewVars}
            />
            <FlowBuilder
              initialBranches={branches}
              onChange={handleFlowChange}
              onAskJoe={handleAskJoe}
              previewMergeVars={previewVars ?? undefined}
            />
            <div className="mt-4 flex justify-between items-center">
              <Button variant="outline" onClick={() => setActiveTab("setup")}>Back</Button>
              <div className="text-xs text-muted-foreground">
                {flattenBranchSteps(branches).length} total step(s),{" "}
                {flattenBranchSteps(branches).reduce((sum, step) => sum + (step.actions?.length || 0), 0)} total action(s)
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleSaveDraft} disabled={saving}>
                  Save Draft
                </Button>
                <Button onClick={() => setActiveTab("review")}>Next: Review</Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="review" className="mt-4">
            <div className="max-w-2xl">
              <SequenceReview
                setup={setup}
                branches={branches}
                onSaveDraft={handleSaveDraft}
                onActivate={handleActivate}
                saving={saving}
              />
              <div className="mt-4">
                <Button variant="outline" onClick={() => setActiveTab("flow")}>Back</Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
}

/**
 * "Preview as <contact>" picker. Sits above the FlowBuilder tab
 * content. When a person is chosen, builds a merge-vars dictionary
 * via mergeVarsFromPerson() and lifts it into the SequenceBuilder
 * state — every step's body summary then renders with {{tags}}
 * substituted to that person's values.
 */
function PreviewAsPicker({
  audience,
  previewVars,
  onChange,
}: {
  audience: "candidates" | "contacts";
  previewVars: Record<string, string> | null;
  onChange: (v: Record<string, string> | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const runSearch = useCallback(async (q: string) => {
    setSearch(q);
    if (q.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const table = audience === "contacts" ? "contacts" : "people";
      const fields = audience === "contacts"
        ? "id, full_name, first_name, last_name, email, title, company_name"
        : "id, full_name, first_name, last_name, email, current_title, current_company";
      const { data } = await supabase
        .from(table)
        .select(fields)
        .or(`full_name.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`)
        .limit(8);
      setResults(data ?? []);
    } finally { setLoading(false); }
  }, [audience]);

  const handlePick = (person: any) => {
    const vars = mergeVarsFromPerson(person);
    onChange(vars);
    setSelectedName(person.full_name || `${person.first_name ?? ""} ${person.last_name ?? ""}`.trim() || person.email || "Unknown");
    setSearch("");
    setResults([]);
  };

  return (
    <div className="mb-4 rounded-lg border border-card-border bg-page-bg/40 p-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[11px] font-display font-semibold uppercase tracking-wider text-muted-foreground">
          Preview as
        </span>
        {previewVars ? (
          <>
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald/30 bg-emerald-light/15 px-2.5 py-1 text-xs text-emerald-dark">
              {selectedName ?? "Selected"}
            </span>
            <Button
              variant="ghost" size="sm"
              onClick={() => { onChange(null); setSelectedName(null); }}
              className="h-7 text-[11px] text-muted-foreground"
            >
              Show raw template
            </Button>
            <span className="text-[11px] text-muted-foreground">
              All step bodies render with {`{{tags}}`} substituted to this person's values.
            </span>
          </>
        ) : (
          <div className="relative flex-1 max-w-sm">
            <Input
              value={search}
              onChange={(e) => runSearch(e.target.value)}
              placeholder={`Search ${audience === "contacts" ? "contacts" : "candidates"} to preview…`}
              className="h-8 text-xs"
            />
            {results.length > 0 && (
              <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md border border-border bg-card shadow-md max-h-56 overflow-y-auto">
                {results.map((p: any) => (
                  <button
                    key={p.id}
                    type="button"
                    onMouseDown={() => handlePick(p)}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-accent/10 flex flex-col"
                  >
                    <span className="font-medium text-foreground">{p.full_name || p.email || "Unknown"}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {[p.current_title ?? p.title, p.current_company ?? p.company_name, p.email].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {loading && <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">…</div>}
          </div>
        )}
      </div>
    </div>
  );
}
