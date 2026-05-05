import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { classifyEmail, normalizeEmail } from '@/lib/email-classifier';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Upload, Loader2, FileText, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { invalidatePersonScope } from '@/lib/invalidate';

interface AddCandidateDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}

const ACCEPTED = '.pdf,.doc,.docx,.txt';

export function AddCandidateDialog({ open: openProp, onOpenChange, children }: AddCandidateDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;
  const setOpen = (v: boolean) => {
    if (isControlled) onOpenChange?.(v);
    else setInternalOpen(v);
  };

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [currentTitle, setCurrentTitle] = useState('');
  const [currentCompany, setCurrentCompany] = useState('');
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [locationText, setLocationText] = useState('');
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeStoragePath, setResumeStoragePath] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const resetForm = () => {
    setFirstName(''); setLastName(''); setEmail(''); setPhone('');
    setCurrentTitle(''); setCurrentCompany(''); setLinkedinUrl(''); setLocationText('');
    setResumeFile(null); setResumeStoragePath(null);
  };

  const handleFilePick = useCallback(async (file: File) => {
    setResumeFile(file);
    setParsing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const storagePath = `${session.user.id}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error: upErr } = await supabase.storage.from('resumes').upload(storagePath, file, {
        contentType: file.type || 'application/pdf',
        upsert: false,
      });
      if (upErr) throw new Error('Upload failed: ' + upErr.message);
      setResumeStoragePath(storagePath);

      const resp = await fetch('/api/parse-resume', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filePath: storagePath, fileName: file.name }),
      });
      const result = await resp.json();
      if (!resp.ok || result.error) throw new Error(result.error || 'Parse failed');

      const p = result.parsed || {};
      if (p.first_name) setFirstName(p.first_name);
      if (p.last_name) setLastName(p.last_name);
      if (p.email) setEmail(p.email);
      if (p.phone) setPhone(p.phone);
      if (p.current_title) setCurrentTitle(p.current_title);
      if (p.current_company) setCurrentCompany(p.current_company);
      if (p.linkedin_url) setLinkedinUrl(p.linkedin_url);
      if (p.location) setLocationText(p.location);
      toast.success('Resume parsed — review and save');
    } catch (err: any) {
      toast.error(err.message || 'Failed to parse resume');
    } finally {
      setParsing(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFilePick(file);
  }, [handleFilePick]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { data: inserted, error } = await supabase
        .from('people')
        .insert([
          {
            first_name: firstName,
            last_name: lastName,
            full_name: `${firstName} ${lastName}`.trim() || null,
            email: normalizeEmail(email),
            ...classifyEmail(normalizeEmail(email)),
            phone: phone || null,
            current_title: currentTitle || null,
            current_company: currentCompany || null,
            linkedin_url: linkedinUrl || null,
            location_text: locationText || null,
            status: 'new',
            owner_user_id: userId,
          },
        ])
        .select('id')
        .single();

      if (error) {
        toast.error(error.message || 'Failed to add candidate');
        return;
      }

      if (inserted && resumeStoragePath && resumeFile) {
        await supabase.from('resumes').insert({
          candidate_id: inserted.id,
          file_path: resumeStoragePath,
          file_name: resumeFile.name,
          mime_type: resumeFile.type || 'application/pdf',
          file_size: resumeFile.size,
          storage_bucket: 'resumes',
          source: 'upload',
          parsing_status: 'completed',
        } as any);

        fetch('/api/trigger-resume-ingestion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidateId: inserted.id }),
        }).catch(() => {});
      }

      toast.success('Candidate added');
      resetForm();
      setOpen(false);

      invalidatePersonScope(queryClient);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to add candidate');
    } finally {
      setLoading(false);
    }
  };

  const showTrigger = !isControlled || !!children;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); setOpen(v); }}>
      {showTrigger && (
        <DialogTrigger asChild>
          {children || <Button>Add Candidate</Button>}
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Candidate</DialogTitle>
          <DialogDescription>
            Drop a resume to auto-fill, or enter details manually.
          </DialogDescription>
        </DialogHeader>

        {/* Resume drop zone */}
        <div
          className={cn(
            'rounded-lg border-2 border-dashed p-4 text-center transition-colors cursor-pointer',
            dragging ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
            parsing && 'pointer-events-none opacity-60',
          )}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => !parsing && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED}
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFilePick(f); e.target.value = ''; }}
          />
          {parsing ? (
            <div className="flex items-center justify-center gap-2 py-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Parsing resume with AI...</span>
            </div>
          ) : resumeFile ? (
            <div className="flex items-center justify-center gap-2 py-1">
              <FileText className="h-4 w-4 text-accent" />
              <span className="text-sm text-foreground">{resumeFile.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); setResumeFile(null); setResumeStoragePath(null); }}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1 py-2">
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Drop resume here or click to browse</span>
              <span className="text-[10px] text-muted-foreground/60">PDF, DOC, DOCX, TXT</span>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-3 py-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">First Name *</Label>
                <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Last Name *</Label>
                <Input value={lastName} onChange={(e) => setLastName(e.target.value)} required />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Email</Label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Phone</Label>
                <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Title</Label>
                <Input value={currentTitle} onChange={(e) => setCurrentTitle(e.target.value)} placeholder="e.g. Senior Analyst" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Company</Label>
                <Input value={currentCompany} onChange={(e) => setCurrentCompany(e.target.value)} placeholder="Current employer" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Location</Label>
                <Input value={locationText} onChange={(e) => setLocationText(e.target.value)} placeholder="City, State" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">LinkedIn</Label>
                <Input value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} placeholder="https://linkedin.com/in/..." />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => { resetForm(); setOpen(false); }}>Cancel</Button>
            <Button variant="gold" type="submit" disabled={loading || parsing || (!firstName.trim() && !lastName.trim())}>
              {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving...</> : 'Add Candidate'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
