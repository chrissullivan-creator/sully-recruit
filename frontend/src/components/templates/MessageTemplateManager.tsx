import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Plus, Search, Pencil, Trash2, Mail, MessageSquare, Linkedin, MessagesSquare, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { cn } from '@/lib/utils';

interface MessageTemplate {
  id: string;
  name: string;
  subject: string | null;
  body: string;
  channel: string;
  category: string | null;
  created_by: string | null;
  is_shared: boolean;
  created_at: string;
  updated_at: string;
}

interface TemplateFormData {
  name: string;
  subject: string;
  body: string;
  channel: string;
  category: string;
  is_shared: boolean;
}

const CHANNELS = [
  { value: 'email', label: 'Email', icon: Mail },
  { value: 'linkedin', label: 'LinkedIn', icon: Linkedin },
  { value: 'sms', label: 'SMS', icon: MessageSquare },
  { value: 'all', label: 'All Channels', icon: MessagesSquare },
] as const;

const CATEGORIES = ['Outreach', 'Follow-up', 'Nurture', 'Rejection', 'Scheduling', 'Other'] as const;

const emptyForm: TemplateFormData = {
  name: '',
  subject: '',
  body: '',
  channel: 'email',
  category: 'Outreach',
  is_shared: false,
};

const channelIcon = (channel: string) => {
  const ch = CHANNELS.find((c) => c.value === channel);
  if (!ch) return null;
  const Icon = ch.icon;
  return <Icon className="h-3.5 w-3.5" />;
};

export function MessageTemplateManager() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MessageTemplate | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateFormData>(emptyForm);

  // ---------- Queries ----------

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['message_templates'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('message_templates')
        .select('*')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data as MessageTemplate[];
    },
  });

  // ---------- Mutations ----------

  const createMutation = useMutation({
    mutationFn: async (payload: TemplateFormData) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from('message_templates').insert({
        name: payload.name,
        subject: payload.subject || null,
        body: payload.body,
        channel: payload.channel,
        category: payload.category || null,
        is_shared: payload.is_shared,
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['message_templates'] });
      toast.success('Template created');
      closeDialog();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: TemplateFormData }) => {
      const { error } = await supabase
        .from('message_templates')
        .update({
          name: payload.name,
          subject: payload.subject || null,
          body: payload.body,
          channel: payload.channel,
          category: payload.category || null,
          is_shared: payload.is_shared,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['message_templates'] });
      toast.success('Template updated');
      closeDialog();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('message_templates').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['message_templates'] });
      toast.success('Template deleted');
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ---------- Helpers ----------

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingId(null);
    setForm(emptyForm);
  };

  const openCreate = () => {
    setForm(emptyForm);
    setEditingId(null);
    setDialogOpen(true);
  };

  const openEdit = (t: MessageTemplate) => {
    setForm({
      name: t.name,
      subject: t.subject ?? '',
      body: t.body,
      channel: t.channel,
      category: t.category ?? 'Other',
      is_shared: t.is_shared,
    });
    setEditingId(t.id);
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!form.name.trim()) {
      toast.error('Name is required');
      return;
    }
    if (!form.body.trim()) {
      toast.error('Body is required');
      return;
    }
    if (editingId) {
      updateMutation.mutate({ id: editingId, payload: form });
    } else {
      createMutation.mutate(form);
    }
  };

  const saving = createMutation.isPending || updateMutation.isPending;

  const filtered = templates.filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    (t.category ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  // ---------- Render ----------

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="h-4 w-4 mr-1.5" />
          New Template
        </Button>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {search ? 'No templates match your search.' : 'No templates yet. Create your first one.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
          {filtered.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-4 px-4 py-3 bg-card hover:bg-muted/50 transition-colors group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-medium text-sm text-foreground truncate">{t.name}</span>
                  <Badge variant="secondary" className="text-[10px] gap-1 shrink-0">
                    {channelIcon(t.channel)}
                    {t.channel}
                  </Badge>
                  {t.category && (
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {t.category}
                    </Badge>
                  )}
                  {t.is_shared && (
                    <Badge variant="outline" className="text-[10px] shrink-0 text-accent">
                      Shared
                    </Badge>
                  )}
                </div>
                {t.subject && (
                  <p className="text-xs text-muted-foreground truncate">Subject: {t.subject}</p>
                )}
              </div>

              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(t)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(t)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Template' : 'New Template'}</DialogTitle>
            <DialogDescription>
              {editingId
                ? 'Update the template details below.'
                : 'Create a reusable message template for outreach.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                placeholder="e.g. Initial Outreach"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            {/* Channel + Category row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Channel</Label>
                <Select value={form.channel} onValueChange={(v) => setForm((f) => ({ ...f, channel: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHANNELS.map((ch) => (
                      <SelectItem key={ch.value} value={ch.value}>
                        {ch.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Subject (optional) */}
            <div className="space-y-1.5">
              <Label htmlFor="tpl-subject">
                Subject <span className="text-muted-foreground text-xs">(optional)</span>
              </Label>
              <Input
                id="tpl-subject"
                placeholder="Email subject line"
                value={form.subject}
                onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
              />
            </div>

            {/* Body */}
            <div className="space-y-1.5">
              <Label>Body</Label>
              <RichTextEditor
                value={form.body}
                onChange={(html) => setForm((f) => ({ ...f, body: html }))}
                placeholder="Write your template message..."
                minHeight="160px"
              />
            </div>

            {/* Shared toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_shared}
                onChange={(e) => setForm((f) => ({ ...f, is_shared: e.target.checked }))}
                className="accent-primary h-4 w-4 rounded"
              />
              <span className="text-sm text-foreground">Share with team</span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {editingId ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default MessageTemplateManager;
