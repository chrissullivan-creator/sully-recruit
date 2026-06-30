import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PicklistMultiSelect } from '@/components/shared/PicklistMultiSelect';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { invalidateCompanyScope } from '@/lib/invalidate';
import { useNavigate } from 'react-router-dom';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddCompanyDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '', domain: '', location: '', linkedin_url: '', company_status: 'none',
  });
  const [industries, setIndustries] = useState<string[]>([]);
  const [strategies, setStrategies] = useState<string[]>([]);
  const showStrategy = industries.includes('Hedge Fund');

  const update = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('Company name is required'); return; }
    setSaving(true);
    try {
      const { error } = await supabase.from('companies').insert({
        name: form.name.trim(),
        domain: form.domain.trim() || null,
        location: form.location.trim() || null,
        linkedin_url: form.linkedin_url.trim() || null,
        company_status: form.company_status === 'none' ? null : form.company_status,
        industries: industries.length ? industries : null,
        // Strategy only applies to hedge funds.
        strategies: showStrategy && strategies.length ? strategies : null,
      } as any);
      if (error) throw error;
      invalidateCompanyScope(queryClient);
      toast.success('Company created');
      setForm({ name: '', domain: '', location: '', linkedin_url: '', company_status: 'none' });
      setIndustries([]);
      setStrategies([]);
      onOpenChange(false);
    } catch (err: any) {
      // The company already exists (unique name OR unique domain). Rather than
      // dump a raw Postgres constraint error, find the existing row and take the
      // user straight to it so they can add contacts — that's what they wanted.
      const isDup = err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message || '');
      if (isDup) {
        const name = form.name.trim();
        const domain = form.domain.trim();
        let existing: any = null;
        const byName = await supabase.from('companies').select('id, name, deleted_at').ilike('name', name).limit(1).maybeSingle();
        existing = byName.data;
        if (!existing && domain) {
          const byDomain = await supabase.from('companies').select('id, name, deleted_at').ilike('domain', domain).limit(1).maybeSingle();
          existing = byDomain.data;
        }
        if (existing && !existing.deleted_at) {
          toast.info(`"${existing.name}" already exists — opening it.`);
          onOpenChange(false);
          navigate(`/companies/${existing.id}`);
          return;
        }
        if (existing?.deleted_at) {
          toast.error(`"${existing.name}" already exists but was deleted. Restore it from Settings → Data Hygiene.`);
          return;
        }
        toast.error('A company with this name or domain already exists.');
        return;
      }
      toast.error(err.message || 'Failed to create company');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Add Company</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name *</Label>
            <Input value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="e.g. Acme Corp" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Domain</Label>
              <Input value={form.domain} onChange={(e) => update('domain', e.target.value)} placeholder="e.g. acme.com" />
            </div>
            <div className="space-y-2">
              <Label>Relationship</Label>
              <Select value={form.company_status} onValueChange={(v) => update('company_status', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No type</SelectItem>
                  <SelectItem value="client">Client</SelectItem>
                  <SelectItem value="target">Target</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Location</Label>
              <Input value={form.location} onChange={(e) => update('location', e.target.value)} placeholder="e.g. New York, NY" />
            </div>
            <div className="space-y-2">
              <Label>LinkedIn URL</Label>
              <Input value={form.linkedin_url} onChange={(e) => update('linkedin_url', e.target.value)} placeholder="https://linkedin.com/company/..." />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Industry</Label>
            <PicklistMultiSelect category="industry" value={industries} onChange={setIndustries} />
          </div>
          {showStrategy && (
            <div className="space-y-2">
              <Label>Strategy</Label>
              <PicklistMultiSelect category="strategy" value={strategies} onChange={setStrategies} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="gold" onClick={handleSave} disabled={saving || !form.name.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Create Company
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
