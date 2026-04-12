import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, BarChart3, Calendar } from "lucide-react";

interface SequenceRow {
  id: string;
  name: string;
  audience_type: string;
  created_at: string;
  job_id: string | null;
  jobs?: { title: string } | null;
  _enrollmentCount?: number;
  _activeCount?: number;
}

export function SequenceList() {
  const [sequences, setSequences] = useState<SequenceRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSequences();
  }, []);

  async function loadSequences() {
    try {
      const { data, error } = await supabase
        .from("sequences")
        .select("id, name, audience_type, created_at, job_id, jobs(title)")
        .order("created_at", { ascending: false }) as any;

      if (error) throw error;

      // Fetch enrollment counts
      const enriched = await Promise.all(
        (data || []).map(async (seq: SequenceRow) => {
          const { count: totalCount } = await supabase
            .from("sequence_enrollments")
            .select("id", { count: "exact", head: true })
            .eq("sequence_id", seq.id);

          const { count: activeCount } = await supabase
            .from("sequence_enrollments")
            .select("id", { count: "exact", head: true })
            .eq("sequence_id", seq.id)
            .eq("status", "active");

          return { ...seq, _enrollmentCount: totalCount || 0, _activeCount: activeCount || 0 };
        }),
      );
      setSequences(enriched);
    } catch (err: any) {
      console.error("Failed to load sequences:", err);
      toast.error(err?.message || "Failed to load sequences");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Sequences</CardTitle>
        <Link to="/sequences/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" /> New Sequence
          </Button>
        </Link>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : sequences.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <p>No sequences yet.</p>
            <Link to="/sequences/new">
              <Button variant="outline" className="mt-4">
                <Plus className="h-4 w-4 mr-2" /> Create Your First Sequence
              </Button>
            </Link>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Audience</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Enrolled</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sequences.map((seq) => (
                <TableRow key={seq.id}>
                  <TableCell className="font-medium">
                    <Link to={`/sequences/${seq.id}/edit`} className="hover:underline">
                      {seq.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">{seq.audience_type}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {seq.jobs?.title || "—"}
                  </TableCell>
                  <TableCell>{seq._enrollmentCount}</TableCell>
                  <TableCell>
                    <Badge variant={seq._activeCount! > 0 ? "default" : "secondary"}>
                      {seq._activeCount}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Link to={`/sequences/${seq.id}/schedule`}>
                        <Button variant="ghost" size="sm">
                          <Calendar className="h-4 w-4" />
                        </Button>
                      </Link>
                      <Link to={`/sequences/${seq.id}/analytics`}>
                        <Button variant="ghost" size="sm">
                          <BarChart3 className="h-4 w-4" />
                        </Button>
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
