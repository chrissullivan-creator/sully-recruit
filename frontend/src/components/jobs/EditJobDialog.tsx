import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SearchableSelect } from '@/components/shared/SearchableSelect';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCompanies, useJobFunctions } from '@/hooks/useData';
import { toast } from 'sonner';
import { Loader2, ExternalLink } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: any;
}

export function EditJobDialog({ open, onOpenChange, job }: Props) {
  const queryClient = useQueryClient();
  const { data: companies = [] } = useCompanies();
  const { data: jobFunctions = [] } = useJobFunctions();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: '',
    company_id: '',
    company_name: '',
    location: '',
    description: '',
    compensation: '',
    status: 'lead',
    job_url: '',
    job_function_id: '',
    num_openings: 1,
  });

  useEffect(() => {
    if (job && open) {
      setForm({
        title: job.title || '',
        company_id: job.company_id || '',
        company_name: job.company_name || '',
        location: job.location || '',
        description: job.description || '',
        compensation: job.compensation || '',
        status: job.status || 'open',
        job_url: job.job_url || '',
        job_function_id: job.job_function_id || '',
        num_openings: job.num_openings ?? 1,
      });
    }
  }, [job, open]);

  const update = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const handleCompanyChange = (companyId: string) => {
    if (!companyId) {
      setForm(prev => ({ ...prev, company_id: '', company_name: '' }));
      return;
    }
    const company = companies.find((c: any) => c.id === companyId);
    setForm(prev => ({
      ...prev,
      company_id: companyId,
      company_name: company?.name ?? '',
    }));
  };

  // Generate next job code for a function
  const generateJobCode = async (functionId: string): Promise<string | null> => {
    if (!functionId) return null;
    const fn = jobFunctions.find((f: any) => f.id === functionId);
    if (!fn) return null;
    const { data: existing } = await supabase
      .from('jobs')
      .select('job_code')
      .eq('job_function_id', functionId)
      .not('job_code', 'is', null);
    const maxNum = (existing ?? []).reduce((max: number, row: any) => {
      const match = row.job_code?.match(/-(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    return `${fn.code}-${String(maxNum + 1).padStart(3, '0')}`;
  };

  const handleSave = async () => {
    if (!form.title.trim()) { toast.error('Title is required'); return; }
    setSaving(true);
    try {
      // Regenerate job code if function changed
      const functionChanged = form.job_function_id !== (job.job_function_id || '');
      let jobCode = job.job_code;
      if (functionChanged) {
        jobCode = form.job_function_id ? await generateJobCode(form.job_function_id) : null;
      }

      const { error } = await supabase
        .from('jobs')
        .update({
          title: form.title,
          company_id: form.company_id || null,
          company_name: form.company_name,
          location: form.location,
          description: form.description,
          compensation: form.compensation,
          status: form.status,
          job_url: form.job_url.trim() || null,
          job_function_id: form.job_function_id || null,
          job_code: jobCode,
          num_openings: form.num_openings || 1,
        })
        .eq('id', job.id);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['job', job.id] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast.success('Job updated successfully');
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update job');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Job</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="title">Job Title *</Label>
            <Input
              id="title"
              value={form.title}
              onChange={(e) => update('title', e.target.value)}
              placeholder="e.g. Senior Software Engineer"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Function</Label>
              <SearchableSelect
                options={(jobFunctions as any[]).map((fn: any) => ({
                  value: fn.id,
                  label: `${fn.name} (${fn.code})`,
                  sublabel: fn.examples?.length > 0 ? fn.examples.join(', ') : undefined,
                }))}
                value={form.job_function_id}
                onChange={v => setForm(prev => ({ ...prev, job_function_id: v }))}
                placeholder="Select function"
                searchPlaceholder="Search functions..."
                clearLabel="No function"
                emptyText="No function found."
              />
              {job.job_code && (
                <p className="text-xs text-muted-foreground mt-1">Current Job Code: <span className="font-mono font-medium text-foreground">{job.job_code}</span></p>
              )}
            </div>
            <div>
              <Label>Number of Openings</Label>
              <Input
                type="number"
                min={1}
                value={form.num_openings}
                onChange={e => setForm(prev => ({ ...prev, num_openings: Math.max(1, parseInt(e.target.value) || 1) }))}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="company">Company</Label>
            <SearchableSelect
              options={(companies as any[]).map((c: any) => ({ value: c.id, label: c.name }))}
              value={form.company_id}
              onChange={handleCompanyChange}
              placeholder="Select company"
              searchPlaceholder="Search companies..."
              clearLabel="No company"
              emptyText="No company found."
            />
          </div>
          <div>
            <Label htmlFor="company_name">Company Name (if not in list)</Label>
            <Input
              id="company_name"
              value={form.company_name}
              onChange={(e) => update('company_name', e.target.value)}
              placeholder="Company name"
            />
          </div>
          <div>
            <Label htmlFor="location">Location</Label>
            <Input
              id="location"
              value={form.location}
              onChange={(e) => update('location', e.target.value)}
              placeholder="e.g. San Francisco, CA or Remote"
            />
          </div>
          <div>
            <Label htmlFor="compensation">Compensation</Label>
            <Input
              id="compensation"
              value={form.compensation}
              onChange={(e) => update('compensation', e.target.value)}
              placeholder="e.g. $120k - $150k"
            />
          </div>
          <div>
            <Label htmlFor="status">Status</Label>
            <Select value={form.status} onValueChange={(value) => update('status', value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lead">Lead</SelectItem>
                <SelectItem value="hot">Hot</SelectItem>
                <SelectItem value="closed_won">Closed Won</SelectItem>
                <SelectItem value="closed_lost">Closed Lost</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="job_url">Job Posting URL</Label>
            <div className="flex gap-2">
              <Input
                id="job_url"
                value={form.job_url}
                onChange={(e) => update('job_url', e.target.value)}
                placeholder="https://..."
                className="flex-1"
              />
              {form.job_url && (
                <a href={form.job_url} target="_blank" rel="noopener noreferrer">
                  <Button variant="ghost" size="icon" type="button" className="h-9 w-9">
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </a>
              )}
            </div>
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <RichTextEditor
              value={form.description}
              onChange={(val) => update('description', val)}
              placeholder="Job description and requirements..."
              minHeight="180px"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="gold" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
