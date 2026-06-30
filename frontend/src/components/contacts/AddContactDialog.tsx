import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CompanyCombobox } from '@/components/shared/CompanyCombobox';
import { PicklistMultiSelect } from '@/components/shared/PicklistMultiSelect';
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
  /** When set, the new contact is linked to this job via job_contacts. */
  jobId?: string;
  /** Pre-select this company in the combobox. */
  defaultCompanyId?: string;
  /** Called with the new person id after a successful create (+ optional job link). */
  onCreated?: (personId: string) => void;
}

const emptyForm = {
  first_name: '', last_name: '', email: '', phone: '',
  linkedin_url: '', title: '',
  company_id: '', status: 'new',
};

export function AddContactDialog({ open, onOpenChange, jobId, defaultCompanyId, onCreated }: Props) {
  const queryClient = useQueryClient();
  const { data: companies = [] } = useCompanies();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ ...emptyForm, company_id: defaultCompanyId || '' });
  const [departments, setDepartments] = useState<string[]>([]);
  const [products, setProducts] = useState<string[]>([]);

  // Keep the company combobox seeded with the job's company while the dialog
  // is closed/reopened from a job page.
  useEffect(() => {
    if (open) setForm((prev) => ({ ...prev, company_id: prev.company_id || defaultCompanyId || '' }));
  }, [open, defaultCompanyId]);

  const update = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const resetForm = () => {
    setForm({ ...emptyForm, company_id: defaultCompanyId || '' });
    setDepartments([]);
    setProducts([]);
  };

  const handleSave = async () => {
    if (!form.first_name.trim() && !form.last_name.trim()) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const linkedinUrl = form.linkedin_url.trim() || null;
      const { data: inserted, error } = await supabase.from('people').insert({
        // roles[] is the source of truth — the sync_people_type_with_roles
        // trigger overrides `type` from roles[]. Without this explicit
        // roles[], the column default `['candidate']` kicks in and the
        // trigger flips type back to 'candidate', so the contact ends up
        // mis-categorised in the candidates list.
        roles: ['client'],
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
        // Keep the legacy free-text `department` populated (first selected) for
        // back-compat while the new departments[] array is the source of truth.
        department: departments[0] || null,
        // NOT NULL text[] columns (default '{}') — send the array, never null.
        // Empty is fine: products/departments aren't required to add a person.
        departments,
        products,
        company_id: form.company_id || null,
        status: form.status,
        owner_user_id: userId,
        // Queue the resolve-unipile-ids cron to populate unipile_provider_id
        // via the v2 endpoint. We also fire /api/resolve-person-now in the
        // background for instant resolution; the cron is the safety net.
        unipile_resolve_status: linkedinUrl ? 'pending' : null,
      } as any).select('id').single();
      if (error) throw error;

      // Link the new contact to the job (when launched from a job page).
      if (jobId && inserted?.id) {
        try {
          const { count } = await supabase
            .from('job_contacts')
            .select('id', { count: 'exact', head: true })
            .eq('job_id', jobId);
          const { error: linkErr } = await supabase.from('job_contacts').insert({
            job_id: jobId,
            contact_id: inserted.id,
            is_primary: (count ?? 0) === 0,
          });
          // 23505 = already linked (unique job_id+contact_id) — treat as success.
          if (linkErr && (linkErr as any).code !== '23505') throw linkErr;
        } catch (linkErr: any) {
          if (linkErr?.code !== '23505') {
            toast.error(`Contact created, but linking to the job failed: ${linkErr.message}`);
          }
        }
      }

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

      if (inserted?.id) onCreated?.(inserted.id);
      resetForm();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create contact');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
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
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={form.title} onChange={(e) => update('title', e.target.value)} placeholder="e.g. VP of Engineering" />
          </div>
          <div className="space-y-2">
            <Label>Department</Label>
            <PicklistMultiSelect category="department" value={departments} onChange={setDepartments} />
          </div>
          <div className="space-y-2">
            <Label>Products</Label>
            <PicklistMultiSelect category="products" value={products} onChange={setProducts} />
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
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="reached_out">Reached out</SelectItem>
                  <SelectItem value="engaged">Engaged</SelectItem>
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
