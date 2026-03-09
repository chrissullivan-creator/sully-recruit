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
  entityType: 'candidate' | 'prospect';
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
}

const PARSE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ask-joe`;

export function ResumeDropZone({ entityType, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parsed, setParsed] = useState<ParsedData | null>(null);

  const update = (field: keyof ParsedData, value: string) =>
    setParsed((prev) => prev ? { ...prev, [field]: value } : null);

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.includes('pdf') && !file.type.includes('doc') && !file.type.includes('text')) {
      toast.error('Please upload a PDF, DOC, or text file');
      return;
    }
    setParsing(true);

    try {
      // Upload to storage
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const filePath = `${userId}/${Date.now()}_${file.name}`;
      const { error: uploadErr } = await supabase.storage.from('resumes').upload(filePath, file);
      if (uploadErr) throw uploadErr;

      // Read text from file
      const text = await file.text();

      // Use AI to parse resume into structured fields
      const resp = await fetch(PARSE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: `Parse this resume and extract structured data. Return ONLY valid JSON with these exact keys: first_name, last_name, email, phone, current_company, current_title, location, linkedin_url. If a field is not found, use an empty string. Here is the resume text:\n\n${text.slice(0, 4000)}`,
            },
          ],
          mode: 'general',
        }),
      });

      if (!resp.ok || !resp.body) throw new Error('AI parsing failed');

      // Read streaming response
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      let done = false;
      while (!done) {
        const { done: d, value } = await reader.read();
        if (d) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
          try {
            const p = JSON.parse(line.slice(6));
            full += p.choices?.[0]?.delta?.content || '';
          } catch { /* skip */ }
        }
      }

      // Extract JSON from response
      const jsonMatch = full.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        setParsed({
          first_name: data.first_name || '',
          last_name: data.last_name || '',
          email: data.email || '',
          phone: data.phone || '',
          current_company: data.current_company || '',
          current_title: data.current_title || '',
          location: data.location || '',
          linkedin_url: data.linkedin_url || '',
          raw_text: text,
          file_name: file.name,
          file_path: filePath,
        });
      } else {
        setParsed({
          first_name: '', last_name: '', email: '', phone: '',
          current_company: '', current_title: '', location: '', linkedin_url: '',
          raw_text: text, file_name: file.name, file_path: filePath,
        });
        toast.info('Could not auto-parse resume. Please fill in the fields manually.');
      }
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
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const table = entityType === 'candidate' ? 'candidates' : 'prospects';
      const { data: record, error } = await supabase
        .from(table)
        .insert({
          first_name: parsed.first_name.trim() || null,
          last_name: parsed.last_name.trim() || null,
          email: parsed.email.trim() || null,
          phone: parsed.phone.trim() || null,
          current_company: parsed.current_company.trim() || null,
          current_title: parsed.current_title.trim() || null,
          location: parsed.location.trim() || null,
          linkedin_url: parsed.linkedin_url.trim() || null,
          owner_id: userId,
          ...(entityType === 'prospect' ? { resume_url: parsed.file_path } : {}),
        } as any)
        .select()
        .single();
      if (error) throw error;

      // Save resume record if candidate
      if (entityType === 'candidate' && record) {
        await supabase.from('candidate_resumes').insert({
          candidate_id: record.id,
          file_path: parsed.file_path,
          file_name: parsed.file_name,
          raw_text: parsed.raw_text.slice(0, 50000),
          parse_status: 'completed',
          source: 'resume_drop',
        } as any);
      }

      qc.invalidateQueries({ queryKey: [table === 'candidates' ? 'candidates' : 'prospects'] });
      toast.success(`${entityType === 'candidate' ? 'Candidate' : 'Prospect'} created from resume`);
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
            {entityType === 'candidate' ? 'New Candidate' : 'New Prospect'} via Resume
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
                <p className="text-sm text-muted-foreground">Parsing resume with AI...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">Drop a resume here or click to upload</p>
                <p className="text-xs text-muted-foreground">PDF, DOC, or TXT files</p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Review parsed data and edit before saving:</p>
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
