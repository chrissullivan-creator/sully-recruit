import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCompanies } from '@/hooks/useData';
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
      });
    }
  }, [job, open]);

  const update = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const handleCompanyChange = (companyId: string) => {
    if (companyId === 'none') {
      update('company_id', '');
      return;
    }
    const company = companies.find((c: any) => c.id === companyId);
    setForm(prev => ({
      ...prev,
      company_id: companyId,
      company_name: company?.name ?? '',
    }));
  };

  const handleSave = async () => {
    if (!form.title.trim()) { toast.error('Title is required'); return; }
    setSaving(true);
    try {
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
          <div>
            <Label htmlFor="company">Company</Label>
            <Select value={form.company_id || 'none'} onValueChange={handleCompanyChange}>
              <SelectTrigger>
                <SelectValue placeholder="Select company" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No company selected</SelectItem>
                {companies.map((company: any) => (
                  <SelectItem key={company.id} value={company.id}>
                    {company.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
