import { useMemo, useState } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { SectionCard } from "@/components/shared/SectionCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from "@/components/ui/table";
import {
  Collapsible, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/contexts/AuthContext";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw, Loader2, ExternalLink, ChevronDown, ChevronRight, AlertTriangle, Wand2, GitMerge } from "lucide-react";
import { Link } from "react-router-dom";

type Severity = "critical" | "high" | "medium" | "low";

interface ResumeIdentity {
  resume_id: string;
  file_name: string | null;
  parsed_first_name: string | null;
  parsed_last_name: string | null;
  parsed_email: string | null;
  parsed_linkedin_url: string | null;
  parsed_current_company: string | null;
  parsed_current_title: string | null;
  created_at: string;
}

interface Suspect {
  candidate_id: string;
  full_name: string;
  current_title: string | null;
  current_company: string | null;
  linkedin_url: string | null;
  resume_count: number;
  resume_identities: ResumeIdentity[];
  severity: Severity;
  reasons: string[];
}

interface ScanResponse {
  scanned_at: string;
  total_resume_rows_scanned: number;
  total_candidates_with_resumes: number;
  total_suspects: number;
  severity_breakdown: Record<Severity, number>;
  suspects: Suspect[];
}

const SEVERITY_STYLES: Record<Severity, string> = {
  critical: "bg-red-500/15 text-red-700 border-red-500/30",
  high:     "bg-orange-500/15 text-orange-700 border-orange-500/30",
  medium:   "bg-yellow-500/15 text-yellow-700 border-yellow-500/30",
  low:      "bg-muted text-muted-foreground border-border",
};

const REASON_LABELS: Record<string, string> = {
  multi_distinct_names_on_resumes:     "Different names on resumes",
  multi_distinct_emails_on_resumes:    "Different emails on resumes",
  multi_distinct_linkedin_on_resumes:  "Different LinkedIn URLs on resumes",
  profile_company_differs_from_resumes:"Profile co. ≠ resume co.",
  profile_linkedin_not_in_resumes:     "Profile LinkedIn ≠ resume LinkedIn",
  bogus_linkedin_slug:                 "Recruiter member-ID LinkedIn",
};

// Auto-fix is only safe for high + medium where the candidate has 2+ resumes.
// CRITICAL = multi-name AND multi-email/linkedin — those are genuinely different
// humans and need a human to decide which resume(s) belong here. LOW = no resume
// signal (just a bad LinkedIn slug), so there's nothing to merge.
function isAutoFixable(s: Suspect): boolean {
  return (s.severity === "high" || s.severity === "medium") && s.resume_count >= 2;
}

export default function CollisionReview() {
  const { session } = useAuth();
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [severityFilter, setSeverityFilter] = useState<Severity | "all">("all");
  const [pendingBulkFix, setPendingBulkFix] = useState<Suspect[] | null>(null);
  const [pendingRowFix, setPendingRowFix] = useState<Suspect | null>(null);

  const scanMutation = useMutation({
    mutationFn: async () => {
      const resp = await fetch("/api/admin/scan-collisions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token || ""}`,
        },
        body: JSON.stringify({ limit: 500 }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Scan failed (${resp.status})`);
      }
      return (await resp.json()) as ScanResponse;
    },
    onSuccess: (data) => {
      setResult(data);
      toast.success(`Scan complete: ${data.total_suspects} suspects across ${data.total_candidates_with_resumes} candidates with resumes.`);
    },
    onError: (err: any) => {
      toast.error(err.message || "Scan failed");
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async (candidate_ids: string[]) => {
      const resp = await fetch("/api/admin/resolve-collision", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token || ""}`,
        },
        body: JSON.stringify({ candidate_ids }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Auto-fix failed (${resp.status})`);
      }
      return await resp.json();
    },
    onSuccess: (data, candidate_ids) => {
      const fixed = (data?.summary?.candidates_fixed as number) ?? 0;
      const deleted = (data?.summary?.total_resumes_deleted as number) ?? 0;
      toast.success(`Auto-fix done: ${fixed} candidate${fixed === 1 ? "" : "s"} cleaned, ${deleted} older resume${deleted === 1 ? "" : "s"} deleted.`);
      // Remove the fixed candidates from the in-memory result so the table reflects reality.
      setResult((prev) => {
        if (!prev) return prev;
        const fixedSet = new Set(candidate_ids);
        return { ...prev, suspects: prev.suspects.filter((s) => !fixedSet.has(s.candidate_id)) };
      });
      setPendingBulkFix(null);
      setPendingRowFix(null);
    },
    onError: (err: any) => {
      toast.error(err.message || "Auto-fix failed");
      setPendingBulkFix(null);
      setPendingRowFix(null);
    },
  });

  const filteredSuspects = useMemo(() => {
    if (!result) return [];
    if (severityFilter === "all") return result.suspects;
    return result.suspects.filter((s) => s.severity === severityFilter);
  }, [result, severityFilter]);

  const autoFixableVisible = useMemo(
    () => filteredSuspects.filter(isAutoFixable),
    [filteredSuspects],
  );

  return (
    <MainLayout>
      <PageHeader
        eyebrow="Data Hygiene"
        title="Candidate record collisions"
        description="Finds candidate rows where two or more real people may have been merged. Different problem than the Duplicates page (which finds two rows that should be one)."
        icon={<GitMerge />}
        actions={
          <div className="flex items-center gap-2">
            {result && autoFixableVisible.length > 0 && (
              <Button
                onClick={() => setPendingBulkFix(autoFixableVisible)}
                disabled={resolveMutation.isPending}
                size="sm"
                variant="outline"
              >
                <Wand2 className="mr-2 h-4 w-4" />
                Auto-fix {autoFixableVisible.length} visible
              </Button>
            )}
            <Button
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending}
              size="sm"
            >
              {scanMutation.isPending
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Scanning…</>
                : <><RefreshCw className="mr-2 h-4 w-4" /> {result ? "Re-scan" : "Scan now"}</>}
            </Button>
          </div>
        }
      />

      <div className="space-y-6 p-8">
      {!result && (
        <SectionCard>
          <div className="py-10 text-center text-muted-foreground">
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-accent opacity-80" />
            <p>Click <strong className="text-foreground">Scan now</strong> to find suspected collision records.</p>
            <p className="mt-2 text-xs">Scan reads every parsed resume and compares against each candidate's profile. Usually takes a few seconds.</p>
          </div>
        </SectionCard>
      )}

      {/* Per-row confirmation */}
      <AlertDialog open={!!pendingRowFix} onOpenChange={(open) => { if (!open) setPendingRowFix(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Auto-fix this candidate?</AlertDialogTitle>
            <AlertDialogDescription>
              Keeps the most recent resume for{" "}
              <strong>{pendingRowFix?.full_name || "this candidate"}</strong> and
              hard-deletes the older {Math.max(0, (pendingRowFix?.resume_count ?? 1) - 1)}{" "}
              resume row{(pendingRowFix?.resume_count ?? 1) - 1 === 1 ? "" : "s"} from
              the database. The underlying PDF files stay in Supabase Storage and
              can be recovered manually if you regret this. <strong>This action
              cannot be undone from the UI.</strong>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resolveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (pendingRowFix) resolveMutation.mutate([pendingRowFix.candidate_id]);
              }}
              disabled={resolveMutation.isPending}
            >
              {resolveMutation.isPending
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Fixing…</>
                : "Auto-fix"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk confirmation */}
      <AlertDialog open={!!pendingBulkFix} onOpenChange={(open) => { if (!open) setPendingBulkFix(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Auto-fix {pendingBulkFix?.length ?? 0} candidates?</AlertDialogTitle>
            <AlertDialogDescription>
              For each candidate, keeps the most recent resume and hard-deletes
              the older resume rows. Across these {pendingBulkFix?.length ?? 0}{" "}
              candidates that will delete approximately{" "}
              <strong>
                {(pendingBulkFix ?? []).reduce((n, s) => n + Math.max(0, s.resume_count - 1), 0)}
              </strong>{" "}
              resume row{(pendingBulkFix ?? []).reduce((n, s) => n + Math.max(0, s.resume_count - 1), 0) === 1 ? "" : "s"}.
              The PDF files stay in Supabase Storage. <strong>This action cannot be
              undone from the UI.</strong>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resolveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (pendingBulkFix?.length) {
                  resolveMutation.mutate(pendingBulkFix.map((s) => s.candidate_id));
                }
              }}
              disabled={resolveMutation.isPending}
            >
              {resolveMutation.isPending
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Fixing…</>
                : `Auto-fix ${pendingBulkFix?.length ?? 0}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {result && (
        <>
          {/* Severity tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(["critical","high","medium","low"] as Severity[]).map((sev) => {
              const n = result.severity_breakdown[sev];
              const active = severityFilter === sev;
              return (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setSeverityFilter(active ? "all" : sev)}
                  className={`rounded-2xl border p-4 text-left shadow-sm transition ${active ? "ring-2 ring-primary" : "hover:brightness-[0.98]"} ${SEVERITY_STYLES[sev]}`}
                >
                  <div className="text-2xl font-semibold tabular-nums">{n}</div>
                  <div className="text-xs uppercase tracking-wide">{sev}</div>
                </button>
              );
            })}
          </div>

          {/* Results table */}
          <SectionCard
            title={`Suspected collisions${severityFilter !== "all" ? ` · ${severityFilter}` : ""}`}
            icon={<GitMerge className="h-4 w-4" />}
            actions={
              severityFilter !== "all" && (
                <Button size="sm" variant="outline" onClick={() => setSeverityFilter("all")}>
                  Clear filter
                </Button>
              )
            }
            flush
          >
            {/* Scan summary */}
            <div className="border-b border-card-border px-5 py-2.5 text-xs text-muted-foreground">
              Scanned {result.total_resume_rows_scanned.toLocaleString()} resume rows ·
              {" "}{result.total_candidates_with_resumes.toLocaleString()} candidates with resumes ·
              {" "}{result.total_suspects.toLocaleString()} suspects ·
              {" "}{new Date(result.scanned_at).toLocaleString()}
            </div>

            <Table>
              <TableHeader className="table-header-green">
                <TableRow>
                  <TableHead className="w-[90px]">Severity</TableHead>
                  <TableHead>Candidate (Sully record)</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead className="text-right w-[90px]">Resumes</TableHead>
                  <TableHead className="w-[80px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSuspects.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                      No suspects in this filter.
                    </TableCell>
                  </TableRow>
                )}
                {filteredSuspects.map((s) => (
                  <SuspectRow
                    key={s.candidate_id}
                    suspect={s}
                    onRequestAutoFix={() => setPendingRowFix(s)}
                    autoFixDisabled={resolveMutation.isPending}
                  />
                ))}
              </TableBody>
            </Table>
          </SectionCard>
        </>
      )}
      </div>
    </MainLayout>
  );
}

function SuspectRow({
  suspect,
  onRequestAutoFix,
  autoFixDisabled,
}: {
  suspect: Suspect;
  onRequestAutoFix: () => void;
  autoFixDisabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const canAutoFix = isAutoFixable(suspect);
  return (
    <>
      <TableRow className="align-top">
        <TableCell>
          <Badge variant="outline" className={SEVERITY_STYLES[suspect.severity]}>
            {suspect.severity}
          </Badge>
        </TableCell>
        <TableCell>
          <div className="font-medium">{suspect.full_name || "(no name)"}</div>
          <div className="text-xs text-muted-foreground">
            {suspect.current_title || "—"}{suspect.current_company ? ` · ${suspect.current_company}` : ""}
          </div>
          {suspect.linkedin_url && (
            <div className="mt-1 text-[11px] text-muted-foreground truncate max-w-[420px]">
              {suspect.linkedin_url}
            </div>
          )}
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1">
            {suspect.reasons.map((r) => (
              <Badge key={r} variant="outline" className="text-[10px]">
                {REASON_LABELS[r] ?? r}
              </Badge>
            ))}
          </div>
        </TableCell>
        <TableCell className="text-right text-sm tabular-nums">
          {suspect.resume_count}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1">
            <Collapsible open={open} onOpenChange={setOpen}>
              <CollapsibleTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                  {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </CollapsibleTrigger>
            </Collapsible>
            <Link
              to={`/candidates/${suspect.candidate_id}`}
              target="_blank"
              rel="noopener"
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Open candidate in new tab"
            >
              <ExternalLink className="h-4 w-4" />
            </Link>
            {canAutoFix && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={onRequestAutoFix}
                disabled={autoFixDisabled}
                title="Keep latest resume, delete older ones"
              >
                <Wand2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/30">
          <TableCell colSpan={5}>
            <div className="p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Resume identities ({suspect.resume_identities.length})
              </div>
              <div className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-sm">
              <Table>
                <TableHeader className="table-header-green">
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Parsed name</TableHead>
                    <TableHead>Parsed company</TableHead>
                    <TableHead>Parsed email</TableHead>
                    <TableHead>Parsed LinkedIn</TableHead>
                    <TableHead>Uploaded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suspect.resume_identities.map((r) => (
                    <TableRow key={r.resume_id}>
                      <TableCell className="text-xs truncate max-w-[180px]">{r.file_name || "—"}</TableCell>
                      <TableCell className="text-xs">
                        {[r.parsed_first_name, r.parsed_last_name].filter(Boolean).join(" ") || "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {[r.parsed_current_title, r.parsed_current_company].filter(Boolean).join(" · ") || "—"}
                      </TableCell>
                      <TableCell className="text-xs">{r.parsed_email || "—"}</TableCell>
                      <TableCell className="text-xs truncate max-w-[200px]">{r.parsed_linkedin_url || "—"}</TableCell>
                      <TableCell className="text-xs">{new Date(r.created_at).toLocaleDateString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
