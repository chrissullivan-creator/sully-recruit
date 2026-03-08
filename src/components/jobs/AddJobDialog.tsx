import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCompanies } from '@/hooks/useSupabaseData';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddJobDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const { data: companies = [] } = useCompanies();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: '',
    company_id: '',
    company_name: '',
    location: '',
    description: '',
    status: 'open',
  });

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
      const insert: any = {
        title: form.title.trim(),
        company_name: form.company_name.trim() || null,
        company_id: form.company_id || null,
        location: form.location.trim() || null,
        description: form.description.trim() || null,
        status: form.status,
      };
      const { error } = await supabase.from('jobs').insert(insert);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast.success('Job created');
      setForm({ title: '', company_id: '', company_name: '', location: '', description: '', status: 'open' });
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create job');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add New Job</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Title *</Label>
            <Input value={form.title} onChange={(e) => update('title', e.target.value)} placeholder="e.g. Senior Software Engineer" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Company</Label>
              <Select value={form.company_id || 'none'} onValueChange={handleCompanyChange}>
                <SelectTrigger><SelectValue placeholder="Select company" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No company</SelectItem>
                  {companies.map((c: any) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Company Name</Label>
              <Input value={form.company_name} onChange={(e) => update('company_name', e.target.value)} placeholder="Or type company name" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Location</Label>
              <Input value={form.location} onChange={(e) => update('location', e.target.value)} placeholder="e.g. New York, NY" />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => update('status', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                  <SelectItem value="on_hold">On Hold</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={form.description} onChange={(e) => update('description', e.target.value)} placeholder="Job description..." rows={4} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="gold" onClick={handleSave} disabled={saving || !form.title.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Create Job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
