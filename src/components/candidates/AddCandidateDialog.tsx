import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddCandidateDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '',
    linkedin_url: '', current_company: '', current_title: '',
    location: '', status: 'active',
  });

  const update = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    if (!form.first_name.trim() && !form.last_name.trim()) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { error } = await supabase.from('candidates').insert({
        first_name: form.first_name.trim() || null,
        last_name: form.last_name.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        linkedin_url: form.linkedin_url.trim() || null,
        current_company: form.current_company.trim() || null,
        current_title: form.current_title.trim() || null,
        location: form.location.trim() || null,
        status: form.status,
        owner_id: userId,
      } as any);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      toast.success('Candidate created');
      setForm({ first_name: '', last_name: '', email: '', phone: '', linkedin_url: '', current_company: '', current_title: '', location: '', status: 'active' });
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create candidate');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Add New Candidate</DialogTitle></DialogHeader>
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
              <Label>Company</Label>
              <Input value={form.current_company} onChange={(e) => update('current_company', e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={form.current_title} onChange={(e) => update('current_title', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Location</Label>
              <Input value={form.location} onChange={(e) => update('location', e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => update('status', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="placed">Placed</SelectItem>
                  <SelectItem value="do_not_contact">Do Not Contact</SelectItem>
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
            Create Candidate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
