import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CompanyCombobox } from '@/components/shared/CompanyCombobox';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCompanies } from '@/hooks/useData';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

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
        status: job.status || 'lead',
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
            <CompanyCombobox
              companies={companies}
              value={form.company_id}
              onChange={handleCompanyChange}
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
                <SelectItem value="offer_made">Offer Made</SelectItem>
                <SelectItem value="closed_won">Closed Won</SelectItem>
                <SelectItem value="closed_lost">Closed Lost</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              placeholder="Job description and requirements..."
              rows={4}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}