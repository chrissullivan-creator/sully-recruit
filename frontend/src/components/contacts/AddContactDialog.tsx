import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CompanyCombobox } from '@/components/shared/CompanyCombobox';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCompanies } from '@/hooks/useData';
import { classifyEmail, normalizeEmail } from '@/lib/email-classifier';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { invalidatePersonScope } from '@/lib/invalidate';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddContactDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const { data: companies = [] } = useCompanies();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '',
    linkedin_url: '', title: '', department: '',
    company_id: '', status: 'active',
  });

  const update = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    if (!form.first_name.trim() && !form.last_name.trim()) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const linkedinUrl = form.linkedin_url.trim() || null;
      const { data: inserted, error } = await supabase.from('people').insert({
        type: 'client',
        first_name: form.first_name.trim() || null,
        last_name: form.last_name.trim() || null,
        full_name: `${form.first_name.trim()} ${form.last_name.trim()}`.trim() || null,
        // classifyEmail returns { work_email } or { personal_email } based on
        // domain. For clients we route outreach via work_email at send time,
        // so corporate addresses land in the right slot automatically.
        ...classifyEmail(normalizeEmail(form.email)),
        phone: form.phone.trim() || null,
        linkedin_url: linkedinUrl,
        title: form.title.trim() || null,
        department: form.department.trim() || null,
        company_id: form.company_id || null,
        status: form.status,
        owner_user_id: userId,
        // Queue the resolve-unipile-ids cron to populate unipile_provider_id
        // via the v2 endpoint. We also fire /api/resolve-person-now in the
        // background for instant resolution; the cron is the safety net.
        unipile_resolve_status: linkedinUrl ? 'pending' : null,
      } as any).select('id').single();
      if (error) throw error;

      invalidatePersonScope(queryClient);
      toast.success('Contact created');

      if (linkedinUrl && inserted?.id) {
        // Fire-and-forget — endpoint never throws, just flips status.
        fetch('/api/resolve-person-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: inserted.id }),
        }).catch(() => {});
      }

      setForm({ first_name: '', last_name: '', email: '', phone: '', linkedin_url: '', title: '', department: '', company_id: '', status: 'active' });
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create contact');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Add Contact</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>First Name *</Label>
              <Input value={form.first_name} onChange={(e) => update('first_name', e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Last Name</Label>
              <Input value={form.last_name} onChange={(e) => update('last_name', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input value={form.phone} onChange={(e) => update('phone', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={form.title} onChange={(e) => update('title', e.target.value)} placeholder="e.g. VP of Engineering" />
            </div>
            <div className="space-y-2">
              <Label>Department</Label>
              <Input value={form.department} onChange={(e) => update('department', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Company</Label>
              <CompanyCombobox
                companies={companies}
                value={form.company_id}
                onChange={(v) => update('company_id', v)}
              />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => update('status', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>LinkedIn URL</Label>
            <Input value={form.linkedin_url} onChange={(e) => update('linkedin_url', e.target.value)} placeholder="https://linkedin.com/in/..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="gold" onClick={handleSave} disabled={saving || (!form.first_name.trim() && !form.last_name.trim())}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Create Contact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
