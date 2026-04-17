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
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Extract a LinkedIn slug from a URL or return the input as-is if already a slug.
 */
function extractLinkedInSlug(input: string): string | null {
  if (!input) return null;
  const match = input.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (match) return match[1];
  // If it looks like a slug already (no slashes/spaces)
  if (/^[\w-]+$/.test(input.trim())) return input.trim();
  return null;
}

/**
 * After saving a contact, resolve their Unipile ID via Chris's Recruiter account.
 * This runs in the background and doesn't block the UI.
 */
async function resolveUnipileIdInBackground(contactId: string, linkedinUrl: string) {
  try {
    const slug = extractLinkedInSlug(linkedinUrl);
    if (!slug) return;

    // Get Chris's Unipile account ID
    const { data: chrisAcct } = await supabase
      .from('integration_accounts')
      .select('unipile_account_id')
      .ilike('account_label', '%Chris Sullivan%')
      .eq('is_active', true)
      .maybeSingle();

    const accountId = chrisAcct?.unipile_account_id;
    if (!accountId) {
      console.warn('No Unipile account found for Chris — skipping ID resolution');
      return;
    }

    // Call resolve-unipile-id edge function
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

    const resp = await fetch(`${supabaseUrl}/functions/v1/resolve-unipile-id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
      },
      body: JSON.stringify({ linkedin_slug: slug, account_id: accountId }),
    });

    if (!resp.ok) {
      console.warn('Failed to resolve Unipile ID:', await resp.text());
      return;
    }

    const result = await resp.json();
    if (result.unipile_id || result.provider_id) {
      // Store in contact_channels (not on contacts table)
      await supabase
        .from('contact_channels')
        .upsert({
          contact_id: contactId,
          channel: 'linkedin',
          unipile_id: result.unipile_id || null,
          provider_id: result.provider_id || null,
          is_connected: true,
        }, { onConflict: 'contact_id,channel' });
    }
  } catch (err) {
    console.warn('Background Unipile ID resolution failed:', err);
  }
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
      const { data: inserted, error } = await supabase.from('contacts').insert({
        first_name: form.first_name.trim() || null,
        last_name: form.last_name.trim() || null,
        full_name: `${form.first_name.trim()} ${form.last_name.trim()}`.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        linkedin_url: form.linkedin_url.trim() || null,
        title: form.title.trim() || null,
        department: form.department.trim() || null,
        company_id: form.company_id || null,
        status: form.status,
        owner_user_id: userId,
      } as any).select('id').single();
      if (error) throw error;

      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['people'] });
      toast.success('Contact created');

      // Resolve Unipile ID in background (non-blocking)
      if (form.linkedin_url.trim() && inserted?.id) {
        resolveUnipileIdInBackground(inserted.id, form.linkedin_url.trim());
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
