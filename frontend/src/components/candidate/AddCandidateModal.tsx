import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Plus, UserPlus } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { CompanyCombobox } from '@/components/shared/CompanyCombobox';
import type { CanonicalStage } from '@/lib/pipeline';

export interface AddCandidateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional job to attach the new candidate to. If set, creates a candidate_jobs row + a send_outs row at the chosen stage. */
  jobId?: string | null;
  /** Stage to drop the new candidate into (only used when jobId is set). Defaults to 'pitch'. */
  stage?: CanonicalStage;
  onCreated?: (personId: string) => void;
}

interface Form {
  first_name: string;
  last_name: string;
  current_title: string;
  company_id: string;
  /** Free-text company entered when no existing company matches. */
  company_name: string;
  target_total_comp: string;
  email: string;
  phone: string;
}

const EMPTY_FORM: Form = {
  first_name: '', last_name: '', current_title: '',
  company_id: '', company_name: '',
  target_total_comp: '', email: '', phone: '',
};

export function AddCandidateModal({
  open, onOpenChange, jobId, stage = 'pitch', onCreated,
}: AddCandidateModalProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  const { data: companies = [] } = useQuery({
    queryKey: ['companies_for_add_candidate'],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase.from('companies').select('id, name').order('name');
      return (data ?? []) as { id: string; name: string }[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const reset = () => setForm({ ...EMPTY_FORM });
  const update = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    if (!form.first_name.trim() || !form.last_name.trim()) {
      toast.error('First and last name are required.');
      return;
    }
    setSaving(true);
    try {
      const fullName = `${form.first_name.trim()} ${form.last_name.trim()}`.trim();
      const targetComp = form.target_total_comp ? Number(form.target_total_comp.replace(/[^0-9.]/g, '')) : null;

      // Resolve company name from picked id OR free-text input.
      const pickedCompany = companies.find((c) => c.id === form.company_id);
      const companyName = pickedCompany?.name || form.company_name.trim() || null;

      // Create the person.
      const { data: person, error: personErr } = await supabase
        .from('people')
        .insert({
          type: 'candidate',
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          full_name: fullName,
          current_title: form.current_title.trim() || null,
          current_company: companyName,
          target_total_comp: targetComp,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          status: 'new',
        })
        .select('id')
        .single();
      if (personErr) throw personErr;

      // If we have a job, also create candidate_jobs + send_outs at the requested stage.
      if (jobId && person?.id) {
        const { data: cj, error: cjErr } = await supabase
          .from('candidate_jobs')
          .insert({
            candidate_id: person.id, job_id: jobId,
            pipeline_stage: stage,
            stage_updated_at: new Date().toISOString(),
          })
          .select('id')
          .single();
        if (cjErr) throw cjErr;

        const { error: soErr } = await supabase
          .from('send_outs')
          .insert({
            candidate_id: person.id, job_id: jobId,
            candidate_job_id: cj?.id ?? null,
            stage,
          });
        if (soErr) throw soErr;
      }

      toast.success(`${fullName} added` + (jobId ? ` to ${stage.replace(/_/g, ' ')}` : ''));
      queryClient.invalidateQueries({ queryKey: ['send_outs_list'] });
      queryClient.invalidateQueries({ queryKey: ['job_funnel'] });
      queryClient.invalidateQueries({ queryKey: ['job_quick_stats'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard_metrics'] });
      onCreated?.(person!.id);
      reset();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to add candidate');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent className="max-w-md bg-page-bg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-emerald-dark">
            <UserPlus className="h-4 w-4" /> Add Candidate
          </DialogTitle>
          <DialogDescription>
            Quickly add a new candidate{jobId ? ' and drop them into this job' : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">First Name <span className="text-gold-deep">*</span></Label>
              <Input value={form.first_name} onChange={(e) => update('first_name', e.target.value)} className="h-9 border-card-border" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Last Name <span className="text-gold-deep">*</span></Label>
              <Input value={form.last_name} onChange={(e) => update('last_name', e.target.value)} className="h-9 border-card-border" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Current Title</Label>
            <Input value={form.current_title} onChange={(e) => update('current_title', e.target.value)} placeholder="e.g. VP Engineering" className="h-9 border-card-border" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Company</Label>
            <CompanyCombobox
              companies={companies}
              value={form.company_id}
              onChange={(v) => { update('company_id', v); update('company_name', ''); }}
              placeholder="Search companies or type a new one"
              className="border-card-border"
            />
            {!form.company_id && (
              <Input
                value={form.company_name}
                onChange={(e) => update('company_name', e.target.value)}
                placeholder="…or type a new company name"
                className="h-9 border-card-border text-xs"
              />
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Target Total Comp</Label>
            <Input
              value={form.target_total_comp}
              onChange={(e) => update('target_total_comp', e.target.value)}
              placeholder="e.g. 250000"
              className="h-9 border-card-border tabular-nums"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Email</Label>
              <Input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} className="h-9 border-card-border" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Phone</Label>
              <Input value={form.phone} onChange={(e) => update('phone', e.target.value)} className="h-9 border-card-border" />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-card-border">
            Cancel
          </Button>
          <Button
            variant="gold"
            onClick={handleSave}
            disabled={saving || !form.first_name.trim() || !form.last_name.trim()}
            className="gap-1.5"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create{jobId ? ' & Add to Pipeline' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
