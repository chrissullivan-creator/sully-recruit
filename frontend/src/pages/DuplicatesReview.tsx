import { useState, useMemo } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  RefreshCw, Loader2, ExternalLink, ChevronLeft, ChevronRight, Copy,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

interface DuplicatePair {
  id: string;
  candidate_id_a: string;
  candidate_id_b: string;
  match_type: string;
  match_value: string | null;
  confidence: number;
  status: string;
  created_at: string;
}

interface CandidateInfo {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  current_company: string | null;
  current_title: string | null;
  created_at: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

const MATCH_TYPE_COLORS: Record<string, string> = {
  email: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  phone: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  linkedin: "bg-sky-500/10 text-sky-500 border-sky-500/20",
};

// ─── Hook: fetch duplicate pairs + candidate details ────────────────────────

function useDuplicates() {
  return useQuery({
    queryKey: ["duplicates"],
    queryFn: async () => {
      // 1. Fetch all pending duplicate pairs
      const { data: pairs, error: pairsErr } = await supabase
        .from("duplicate_candidates")
        .select("*")
        .eq("status", "pending")
        .order("confidence", { ascending: false });

      if (pairsErr) throw pairsErr;
      if (!pairs || pairs.length === 0) return { pairs: [], candidates: new Map<string, CandidateInfo>() };

      // 2. Collect unique candidate IDs
      const ids = new Set<string>();
      for (const p of pairs) {
        ids.add(p.candidate_id_a);
        ids.add(p.candidate_id_b);
      }

      // 3. Fetch candidate details (batch in chunks of 100 for large sets)
      const idArr = Array.from(ids);
      const candidates = new Map<string, CandidateInfo>();

      for (let i = 0; i < idArr.length; i += 100) {
        const chunk = idArr.slice(i, i + 100);
        const { data: cands, error: candErr } = await supabase
          .from("people")
          .select("id, first_name, last_name, primary_email, personal_email, work_email, phone, current_company, current_title, created_at")
          .in("id", chunk);

        if (candErr) throw candErr;
        for (const c of cands || []) {
          candidates.set((c as any).id, c as unknown as CandidateInfo);
        }
      }

      return { pairs: pairs as DuplicatePair[], candidates };
    },
  });
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function DuplicatesReview() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const { data, isLoading } = useDuplicates();

  const pairs = data?.pairs ?? [];
  const candidates = data?.candidates ?? new Map<string, CandidateInfo>();

  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [scanning, setScanning] = useState(false);

  // Merge confirmation state
  const [mergeDialog, setMergeDialog] = useState<{
    survivorId: string;
    mergedId: string;
    survivorName: string;
    mergedName: string;
  } | null>(null);
  const [merging, setMerging] = useState(false);

  // ── Filtered + paginated pairs ──

  const filtered = useMemo(() => {
    if (filter === "all") return pairs;
    return pairs.filter((p) => p.match_type === filter);
  }, [pairs, filter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Reset page when filter changes
  const handleFilterChange = (val: string) => {
    setFilter(val);
    setPage(0);
  };

  // ── Count badges ──

  const counts = useMemo(() => {
    const c = { all: pairs.length, email: 0, phone: 0, linkedin: 0 };
    for (const p of pairs) {
      if (p.match_type === "email") c.email++;
      else if (p.match_type === "phone") c.phone++;
      else if (p.match_type === "linkedin") c.linkedin++;
    }
    return c;
  }, [pairs]);

  // ── Actions ──

  const handleScan = async () => {
    setScanning(true);
    try {
      const resp = await fetch("/api/dedup/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token || ""}`,
        },
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || "Scan request failed");
      }
      toast.success("Duplicate scan started. Results will appear shortly.");
      // Poll for results after a delay
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["duplicates"] }), 5000);
    } catch (err: any) {
      toast.error(err.message || "Failed to start scan");
    } finally {
      setScanning(false);
    }
  };

  const handleDismiss = async (pairId: string) => {
    try {
      const resp = await fetch("/api/dedup/dismiss", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token || ""}`,
        },
        body: JSON.stringify({ duplicatePairId: pairId }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || "Dismiss failed");
      }
      // Optimistic remove
      queryClient.setQueryData(["duplicates"], (old: typeof data) => {
        if (!old) return old;
        return { ...old, pairs: old.pairs.filter((p) => p.id !== pairId) };
      });
      toast.success("Duplicate pair dismissed");
    } catch (err: any) {
      toast.error(err.message || "Failed to dismiss");
    }
  };

  const handleMerge = async () => {
    if (!mergeDialog) return;
    setMerging(true);
    try {
      const resp = await fetch("/api/dedup/merge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token || ""}`,
        },
        body: JSON.stringify({
          survivorId: mergeDialog.survivorId,
          mergedId: mergeDialog.mergedId,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || "Merge request failed");
      }
      // Optimistic remove all pairs involving the merged candidate
      queryClient.setQueryData(["duplicates"], (old: typeof data) => {
        if (!old) return old;
        return {
          ...old,
          pairs: old.pairs.filter(
            (p) =>
              p.candidate_id_a !== mergeDialog.mergedId &&
              p.candidate_id_b !== mergeDialog.mergedId
          ),
        };
      });
      toast.success(
        `Merged "${mergeDialog.mergedName}" into "${mergeDialog.survivorName}"`
      );
    } catch (err: any) {
      toast.error(err.message || "Failed to trigger merge");
    } finally {
      setMerging(false);
      setMergeDialog(null);
    }
  };

  // ── Helpers ──

  const candidateName = (id: string): string => {
    const c = candidates.get(id);
    if (!c) return "Unknown";
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
    return name || c.email || "Unknown";
  };

  const candidateDetail = (id: string) => candidates.get(id);

  // ── Render ────

  return (
    <MainLayout>
      <PageHeader
        title="Duplicate Candidates"
        description={`${pairs.length} pending duplicate${pairs.length !== 1 ? "s" : ""} to review`}
        actions={
          <Button onClick={handleScan} disabled={scanning} variant="gold">
            {scanning ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Run Scan
          </Button>
        }
      />

      <div className="px-8 py-6 space-y-4">
        {/* Filter tabs */}
        <Tabs value={filter} onValueChange={handleFilterChange}>
          <TabsList>
            <TabsTrigger value="all">
              All <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">{counts.all}</Badge>
            </TabsTrigger>
            <TabsTrigger value="email">
              Email <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">{counts.email}</Badge>
            </TabsTrigger>
            <TabsTrigger value="phone">
              Phone <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">{counts.phone}</Badge>
            </TabsTrigger>
            <TabsTrigger value="linkedin">
              LinkedIn <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">{counts.linkedin}</Badge>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Copy className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground text-sm">
              No pending duplicates. Run a scan to detect new ones.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[100px]">Match</TableHead>
                    <TableHead className="w-[80px]">Confidence</TableHead>
                    <TableHead>Candidate A</TableHead>
                    <TableHead>Candidate B</TableHead>
                    <TableHead className="text-right w-[320px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginated.map((pair) => {
                    const a = candidateDetail(pair.candidate_id_a);
                    const b = candidateDetail(pair.candidate_id_b);
                    const nameA = candidateName(pair.candidate_id_a);
                    const nameB = candidateName(pair.candidate_id_b);

                    return (
                      <TableRow key={pair.id}>
                        {/* Match type badge */}
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={MATCH_TYPE_COLORS[pair.match_type] || ""}
                          >
                            {pair.match_type}
                          </Badge>
                        </TableCell>

                        {/* Confidence */}
                        <TableCell className="font-mono text-sm">
                          {(pair.confidence * 100).toFixed(0)}%
                        </TableCell>

                        {/* Candidate A */}
                        <TableCell>
                          <CandidateCell candidate={a} name={nameA} id={pair.candidate_id_a} />
                        </TableCell>

                        {/* Candidate B */}
                        <TableCell>
                          <CandidateCell candidate={b} name={nameB} id={pair.candidate_id_b} />
                        </TableCell>

                        {/* Actions */}
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() =>
                                setMergeDialog({
                                  survivorId: pair.candidate_id_a,
                                  mergedId: pair.candidate_id_b,
                                  survivorName: nameA,
                                  mergedName: nameB,
                                })
                              }
                            >
                              Merge &rarr; A
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() =>
                                setMergeDialog({
                                  survivorId: pair.candidate_id_b,
                                  mergedId: pair.candidate_id_a,
                                  survivorName: nameB,
                                  mergedName: nameA,
                                })
                              }
                            >
                              Merge &rarr; B
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => handleDismiss(pair.id)}
                            >
                              Dismiss
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <p className="text-sm text-muted-foreground">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)}{" "}
                  of {filtered.length}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {page + 1} of {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Merge confirmation dialog */}
      <AlertDialog open={!!mergeDialog} onOpenChange={(open) => !open && setMergeDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Merge</AlertDialogTitle>
            <AlertDialogDescription>
              This will merge <strong>"{mergeDialog?.mergedName}"</strong> into{" "}
              <strong>"{mergeDialog?.survivorName}"</strong>. All related records (conversations,
              messages, resumes, etc.) will be reassigned to the survivor. The merged candidate will
              be deleted. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={merging}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleMerge} disabled={merging}>
              {merging ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Merge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
}

// ─── Sub-component: candidate info cell ─────────────────────────────────────

function CandidateCell({
  candidate,
  name,
  id,
}: {
  candidate: CandidateInfo | undefined;
  name: string;
  id: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-sm">{name}</span>
        <a
          href={`/candidates/${id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {candidate && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {candidate.email && <div>{candidate.email}</div>}
          {candidate.phone && <div>{candidate.phone}</div>}
          {candidate.current_company && (
            <div>
              {candidate.current_title ? `${candidate.current_title} @ ` : ""}
              {candidate.current_company}
            </div>
          )}
          <div className="text-[10px] text-muted-foreground/60">
            Added {new Date(candidate.created_at).toLocaleDateString()}
          </div>
        </div>
      )}
    </div>
  );
}
