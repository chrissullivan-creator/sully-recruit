import { useMemo, useState } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from "@/components/ui/table";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useAuth } from "@/contexts/AuthContext";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw, Loader2, ExternalLink, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
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

export default function CollisionReview() {
  const { session } = useAuth();
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [severityFilter, setSeverityFilter] = useState<Severity | "all">("all");

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

  const filteredSuspects = useMemo(() => {
    if (!result) return [];
    if (severityFilter === "all") return result.suspects;
    return result.suspects.filter((s) => s.severity === severityFilter);
  }, [result, severityFilter]);

  return (
    <MainLayout>
      <PageHeader
        title="Candidate record collisions"
        description="Finds candidate rows where two or more real people may have been merged. Different problem than the Duplicates page (which finds two rows that should be one)."
        actions={
          <Button
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
            size="sm"
          >
            {scanMutation.isPending
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Scanning…</>
              : <><RefreshCw className="mr-2 h-4 w-4" /> {result ? "Re-scan" : "Scan now"}</>}
          </Button>
        }
      />

      {!result && (
        <div className="rounded-md border bg-muted/30 p-8 text-center text-muted-foreground">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 opacity-60" />
          <p>Click <strong>Scan now</strong> to find suspected collision records.</p>
          <p className="mt-2 text-xs">Scan reads every parsed resume and compares against each candidate's profile. Usually takes a few seconds.</p>
        </div>
      )}

      {result && (
        <>
          {/* Severity tiles */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(["critical","high","medium","low"] as Severity[]).map((sev) => {
              const n = result.severity_breakdown[sev];
              const active = severityFilter === sev;
              return (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setSeverityFilter(active ? "all" : sev)}
                  className={`rounded-md border p-3 text-left transition ${active ? "ring-2 ring-primary" : "hover:bg-muted/50"} ${SEVERITY_STYLES[sev]}`}
                >
                  <div className="text-2xl font-semibold">{n}</div>
                  <div className="text-xs uppercase tracking-wide">{sev}</div>
                </button>
              );
            })}
          </div>

          {/* Scan summary */}
          <div className="mb-3 text-xs text-muted-foreground">
            Scanned {result.total_resume_rows_scanned.toLocaleString()} resume rows ·
            {" "}{result.total_candidates_with_resumes.toLocaleString()} candidates with resumes ·
            {" "}{result.total_suspects.toLocaleString()} suspects ·
            {" "}{new Date(result.scanned_at).toLocaleString()}
            {severityFilter !== "all" && (
              <Button size="sm" variant="link" className="ml-2 h-auto p-0 text-xs" onClick={() => setSeverityFilter("all")}>
                Clear filter
              </Button>
            )}
          </div>

          {/* Results table */}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
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
                  <SuspectRow key={s.candidate_id} suspect={s} />
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </MainLayout>
  );
}

function SuspectRow({ suspect }: { suspect: Suspect }) {
  const [open, setOpen] = useState(false);
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
          </div>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/30">
          <TableCell colSpan={5}>
            <div className="px-2 py-2">
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                Resume identities ({suspect.resume_identities.length})
              </div>
              <Table>
                <TableHeader>
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
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
