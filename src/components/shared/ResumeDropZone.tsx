import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Upload, Loader2, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface Props {
  entityType: 'candidate';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ParsedData {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  current_company: string;
  current_title: string;
  location: string;
  linkedin_url: string;
  raw_text: string;
  file_name: string;
  file_path: string;
  candidate_id: string | null;
}

const PROCESS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-resume`;

export function ResumeDropZone({ entityType, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parsed, setParsed] = useState<ParsedData | null>(null);

  const update = (field: keyof ParsedData, value: string) =>
    setParsed((prev) => prev ? { ...prev, [field]: value } : null);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.(pdf|doc|docx|txt)$/i)) {
      toast.error('Please upload a PDF, DOC, DOCX, or TXT file');
      return;
    }
    setParsing(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated');

      // Step 1: Upload file to Supabase storage
      const ext = file.name.split('.').pop();
      const storagePath = `${session.user.id}/${Date.now()}_${file.name}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('resumes')
        .upload(storagePath, file, { contentType: file.type || 'application/pdf', upsert: false });

      if (uploadError) throw new Error('Upload failed: ' + uploadError.message);

      // Step 2: Call process-resume with the file_path
      const resp = await fetch(PROCESS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file_path: uploadData.path,
          file_name: file.name,
        }),
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => null);
        throw new Error(errData?.error || 'Failed to process resume');
      }

      const result = await resp.json();
      const data = result.parsed;

      setParsed({
        first_name:      data.first_name || '',
        last_name:       data.last_name || '',
        email:           data.email || '',
        phone:           data.phone || '',
        current_company: data.current_company || '',
        current_title:   data.current_title || '',
        location:        data.location || '',
        linkedin_url:    data.linkedin_url || '',
        raw_text:        '',
        file_name:       file.name,
        file_path:       uploadData.path,
        candidate_id:    result.candidate_id || null,
      });

      toast.success(
        result.candidate_id
          ? `Candidate ${result.parsed?.first_name ? 'updated' : 'created'} · Ask Joe indexed resume`
          : 'Resume parsed — review and save'
      );
    } catch (err: any) {
      toast.error(err.message || 'Failed to process resume');
    } finally {
      setParsing(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleSave = async () => {
    if (!parsed) return;
    if (!parsed.first_name.trim() && !parsed.last_name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    try {
      if (parsed.candidate_id) {
        // Candidate already created/updated by process-resume — apply any manual review edits
        const { error } = await supabase
          .from('candidates')
          .update({
            first_name:      parsed.first_name.trim() || undefined,
            last_name:       parsed.last_name.trim() || undefined,
            full_name:       `${parsed.first_name.trim()} ${parsed.last_name.trim()}`.trim() || undefined,
            email:           parsed.email.trim() || undefined,
            phone:           parsed.phone.trim() || undefined,
            current_company: parsed.current_company.trim() || undefined,
            current_title:   parsed.current_title.trim() || undefined,
            location_text:   parsed.location.trim() || undefined,
            linkedin_url:    parsed.linkedin_url.trim() || undefined,
            updated_at:      new Date().toISOString(),
          } as any)
          .eq('id', parsed.candidate_id);
        if (error) throw error;
        toast.success('Candidate saved');
      } else {
        // Fallback if edge function didn't return a candidate_id
        const userId = (await supabase.auth.getUser()).data.user?.id;
        const { error } = await supabase.from('candidates').insert({
          owner_user_id:   userId,
          first_name:      parsed.first_name.trim() || null,
          last_name:       parsed.last_name.trim() || null,
          full_name:       `${parsed.first_name.trim()} ${parsed.last_name.trim()}`.trim() || null,
          email:           parsed.email.trim() || null,
          phone:           parsed.phone.trim() || null,
          current_company: parsed.current_company.trim() || null,
          current_title:   parsed.current_title.trim() || null,
          location_text:   parsed.location.trim() || null,
          linkedin_url:    parsed.linkedin_url.trim() || null,
          status: 'new',
        } as any);
        if (error) throw error;
        toast.success('Candidate created');
      }

      qc.invalidateQueries({ queryKey: ['candidates'] });
      setParsed(null);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = (val: boolean) => {
    if (!val) setParsed(null);
    onOpenChange(val);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-accent" />
            Ask Joe — {entityType === 'candidate' ? 'New Candidate' : 'New Prospect'} via Resume
          </DialogTitle>
        </DialogHeader>

        {!parsed ? (
          <div
            className={cn(
              'border-2 border-dashed rounded-lg p-12 text-center transition-colors cursor-pointer',
              dragging ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50'
            )}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.pdf,.doc,.docx,.txt';
              input.onchange = (e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) handleFile(f);
              };
              input.click();
            }}
          >
            {parsing ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-8 w-8 animate-spin text-accent" />
                <p className="text-sm text-muted-foreground">Ask Joe is parsing resume...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">Drop a resume here or click to upload</p>
                <p className="text-xs text-muted-foreground">PDF, DOC, or TXT — Ask Joe will parse it</p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Ask Joe extracted this data. Review and edit before saving:</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">First Name</Label>
                <Input value={parsed.first_name} onChange={(e) => update('first_name', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Last Name</Label>
                <Input value={parsed.last_name} onChange={(e) => update('last_name', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Email</Label>
                <Input value={parsed.email} onChange={(e) => update('email', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Phone</Label>
                <Input value={parsed.phone} onChange={(e) => update('phone', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Company</Label>
                <Input value={parsed.current_company} onChange={(e) => update('current_company', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Title</Label>
                <Input value={parsed.current_title} onChange={(e) => update('current_title', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Location</Label>
                <Input value={parsed.location} onChange={(e) => update('location', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">LinkedIn</Label>
                <Input value={parsed.linkedin_url} onChange={(e) => update('linkedin_url', e.target.value)} />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">Source: {parsed.file_name}</p>
          </div>
        )}

        {parsed && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => setParsed(null)}>Re-upload</Button>
            <Button variant="gold" onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Create {entityType === 'candidate' ? 'Candidate' : 'Prospect'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
