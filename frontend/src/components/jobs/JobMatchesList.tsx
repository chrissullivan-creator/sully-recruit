import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";

interface CandidateMatch {
  id: string;
  overall_score: number;
  tier: string;
  reasoning: string;
  strengths: string[];
  concerns: string[];
  vector_similarity: number;
  created_at: string;
  candidate_id: string;
  candidates: {
    id: string;
    full_name: string;
    current_title: string;
    current_company: string;
    location: string;
    location_text: string;
    linkedin_url: string;
    avatar_url: string;
    profile_picture_url: string;
    status: string;
  };
}

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 80
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : score >= 60
        ? "bg-amber-100 text-amber-800 border-amber-300"
        : "bg-gray-100 text-gray-600 border-gray-300";

  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold border ${color}`}
    >
      {score}
    </span>
  );
}

export default function JobMatchesList({ jobId }: { jobId: string }) {
  const [matches, setMatches] = useState<CandidateMatch[]>([]);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchMatches = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/matches?page=${p}&per_page=${perPage}`);
      const data = await res.json();
      setMatches(data.matches || []);
      setTotalPages(data.totalPages || 0);
      setTotal(data.total || 0);
    } catch (err) {
      console.error("Failed to fetch matches:", err);
    }
    setLoading(false);
  }, [jobId, perPage]);

  useEffect(() => {
    fetchMatches(page);
  }, [page, fetchMatches]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const triggerRes = await fetch("/api/trigger-best-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const { runId } = await triggerRes.json();

      // Poll for completion (check every 4s, up to 2 minutes)
      const maxAttempts = 30;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const pollRes = await fetch(`/api/jobs/${jobId}/match-run-status?runId=${runId}`);
        if (pollRes.ok) {
          const { status } = await pollRes.json();
          if (status === "completed" || status === "failed") break;
        }
      }

      await fetchMatches(1);
      setPage(1);
    } catch (err) {
      console.error("Refresh failed:", err);
    }
    setRefreshing(false);
  };

  const lastMatchedAt = matches[0]?.created_at;

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">
            AI Candidate Matches
          </h3>
          {lastMatchedAt && (
            <p className="text-xs text-gray-500 mt-0.5">
              Last run:{" "}
              {new Date(lastMatchedAt).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </p>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 disabled:opacity-50 transition-colors"
        >
          {refreshing ? (
            <>
              <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Matching…
            </>
          ) : (
            <>
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182"
                />
              </svg>
              Refresh
            </>
          )}
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="p-8 text-center text-sm text-gray-500">
          Loading matches…
        </div>
      ) : matches.length === 0 ? (
        <div className="p-8 text-center">
          <p className="text-sm text-gray-500 mb-3">No matches yet.</p>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-sm text-emerald-600 hover:text-emerald-700 font-medium"
          >
            Run matching now →
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {matches.map((m, idx) => {
            const c = m.candidates;
            const rank = (page - 1) * perPage + idx + 1;
            const avatarUrl = c.profile_picture_url || c.avatar_url;

            return (
              <li
                key={m.id}
                className="px-4 py-3 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-start gap-3">
                  {/* Rank */}
                  <span className="text-xs font-mono text-gray-400 mt-1 w-5 text-right shrink-0">
                    {rank}
                  </span>

                  {/* Avatar */}
                  <div className="shrink-0">
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt=""
                        className="w-9 h-9 rounded-full object-cover"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium text-gray-500">
                        {(c.full_name || "?")[0]}
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/candidates/${c.id}`}
                        className="text-sm font-medium text-gray-900 hover:text-emerald-700 truncate"
                      >
                        {c.full_name || "Unknown"}
                      </Link>
                      <ScoreBadge score={m.overall_score} />
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {c.current_title}
                      {c.current_company ? ` @ ${c.current_company}` : ""}
                    </p>
                    {m.reasoning && (
                      <p className="text-xs text-gray-600 mt-1 line-clamp-2">
                        {m.reasoning}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="shrink-0 flex items-center gap-1">
                    {c.linkedin_url && (
                      <a
                        href={c.linkedin_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 text-gray-400 hover:text-blue-600"
                        title="LinkedIn"
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                        </svg>
                      </a>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Pagination */}
      {(totalPages > 1 || total > 0) && (
        <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
          <p className="text-xs text-gray-500">
            {total} matches
          </p>
          <div className="flex items-center gap-3">
            <select
              value={perPage}
              onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}
              className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white"
            >
              <option value={25}>25 / page</option>
              <option value={50}>50 / page</option>
              <option value={100}>100 / page</option>
            </select>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-2 py-1 text-xs rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
                >
                  ←
                </button>
                <span className="text-xs text-gray-600 px-2">
                  {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-2 py-1 text-xs rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
                >
                  →
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
