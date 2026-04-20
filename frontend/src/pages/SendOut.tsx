import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useCandidate, useJobs, useContacts } from '@/hooks/useData';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useProfiles } from '@/hooks/useProfiles';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import jsPDF from 'jspdf';
import emeraldLogo from '@/assets/emerald-logo-resume.png';
import {
  ArrowLeft, ArrowRight, FileText, Upload, Sparkles, Loader2, Edit, Download, Mail, Send,
  Plus, Trash2, Check, Eye, Briefcase, User, GraduationCap, Wrench, Award,
} from 'lucide-react';

const BACKEND_URL = import.meta.env.REACT_APP_BACKEND_URL || '';

// Template types
type TemplateName = 'full_name' | 'full_name_contact' | 'first_name' | 'anonymous';
const TEMPLATES: { value: TemplateName; label: string; desc: string }[] = [
  { value: 'full_name', label: 'Full Name', desc: 'Name only at top' },
  { value: 'full_name_contact', label: 'Full Name + Contact', desc: 'Name, email, phone, location' },
  { value: 'first_name', label: 'First Name Only', desc: 'Privacy-preserving' },
  { value: 'anonymous', label: 'Anonymous', desc: 'No name, title only' },
];

interface ResumeData {
  name: string;
  email: string;
  phone: string;
  linkedin: string;
  location: string;
  summary: string;
  experience: { company: string; title: string; start_date: string; end_date: string; duration: string; responsibilities: string[] }[];
  education: { institution: string; degree: string; field: string; year: string }[];
  skills: string[];
  certifications: string[];
  technical_systems: string[];
}

const emptyResume: ResumeData = {
  name: '', email: '', phone: '', linkedin: '', location: '', summary: '',
  experience: [], education: [], skills: [], certifications: [], technical_systems: [],
};

// ── PDF Generation ──────────────────────────────────────────────────────────
function generatePDF(data: ResumeData, template: TemplateName): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 54;
  const lineH = 14;
  let y = margin;

  const darkGreen = [30, 61, 46];
  const gold = [180, 150, 60];
  const black = [33, 33, 33];
  const gray = [100, 100, 100];

  const checkPage = (needed: number) => {
    if (y + needed > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const drawLine = () => {
    doc.setDrawColor(darkGreen[0], darkGreen[1], darkGreen[2]);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageW - margin, y);
    y += 8;
  };

  const sectionHeader = (title: string) => {
    checkPage(30);
    y += 6;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(darkGreen[0], darkGreen[1], darkGreen[2]);
    doc.text(title.toUpperCase(), margin, y);
    y += 4;
    drawLine();
  };

  // Try to add logo in top-right
  try {
    doc.addImage(emeraldLogo, 'PNG', pageW - margin - 60, margin - 10, 55, 55);
  } catch { /* logo load failed, skip */ }

  // Header — name based on template
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(darkGreen[0], darkGreen[1], darkGreen[2]);
  let displayName = data.name;
  if (template === 'first_name') displayName = data.name.split(' ')[0];
  if (template === 'anonymous') displayName = data.experience[0]?.title || 'Candidate Profile';
  doc.text(displayName, margin, y + 4);
  y += 24;

  // Contact info for full_name_contact template
  if (template === 'full_name_contact') {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(gray[0], gray[1], gray[2]);
    const contactParts = [data.email, data.phone, data.location].filter(Boolean);
    if (contactParts.length) {
      doc.text(contactParts.join('  |  '), margin, y);
      y += lineH;
    }
  }

  drawLine();

  // Summary
  if (data.summary) {
    sectionHeader('Professional Summary');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(black[0], black[1], black[2]);
    const lines = doc.splitTextToSize(data.summary, pageW - 2 * margin);
    lines.forEach((line: string) => {
      checkPage(lineH);
      doc.text(line, margin, y);
      y += lineH;
    });
  }

  // Experience
  if (data.experience.length > 0) {
    sectionHeader('Experience');
    data.experience.forEach((exp) => {
      checkPage(40);
      // Company + duration on same line
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(black[0], black[1], black[2]);
      doc.text(exp.company, margin, y);
      if (exp.duration) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(gray[0], gray[1], gray[2]);
        doc.text(exp.duration, pageW - margin, y, { align: 'right' });
      }
      y += lineH;

      // Title + dates
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(10);
      doc.setTextColor(black[0], black[1], black[2]);
      doc.text(exp.title, margin + 8, y);
      const dates = [exp.start_date, exp.end_date].filter(Boolean).join(' - ');
      if (dates) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(gray[0], gray[1], gray[2]);
        doc.text(dates, pageW - margin, y, { align: 'right' });
      }
      y += lineH + 2;

      // Responsibilities
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(black[0], black[1], black[2]);
      (exp.responsibilities || []).forEach((resp) => {
        const bulletLines = doc.splitTextToSize(resp, pageW - 2 * margin - 20);
        bulletLines.forEach((line: string, li: number) => {
          checkPage(lineH);
          if (li === 0) doc.text('•', margin + 10, y);
          doc.text(line, margin + 22, y);
          y += lineH;
        });
      });
      y += 4;
    });
  }

  // Education
  if (data.education.length > 0) {
    sectionHeader('Education');
    data.education.forEach((edu) => {
      checkPage(24);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(black[0], black[1], black[2]);
      doc.text(edu.institution, margin, y);
      if (edu.year) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(gray[0], gray[1], gray[2]);
        doc.text(edu.year, pageW - margin, y, { align: 'right' });
      }
      y += lineH;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(black[0], black[1], black[2]);
      doc.text([edu.degree, edu.field].filter(Boolean).join(', '), margin + 8, y);
      y += lineH + 4;
    });
  }

  // Technical Skills & Systems
  const allSkills = [...(data.skills || []), ...(data.technical_systems || [])];
  if (allSkills.length > 0) {
    sectionHeader('Technical Skills & Systems');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(black[0], black[1], black[2]);
    const skillText = allSkills.join(', ');
    const skillLines = doc.splitTextToSize(skillText, pageW - 2 * margin);
    skillLines.forEach((line: string) => {
      checkPage(lineH);
      doc.text(line, margin, y);
      y += lineH;
    });
  }

  // Certifications
  if (data.certifications?.length > 0) {
    sectionHeader('Certifications');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(black[0], black[1], black[2]);
    data.certifications.forEach((cert) => {
      checkPage(lineH);
      doc.text(`• ${cert}`, margin + 10, y);
      y += lineH;
    });
  }

  return doc;
}

// ── Main Page ───────────────────────────────────────────────────────────────
export default function SendOut() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: candidate, isLoading: candLoading } = useCandidate(id);
  const { data: jobs = [] } = useJobs();
  const { data: contacts = [] } = useContacts();
  const { data: profiles = [] } = useProfiles();

  // Steps: pick_resume → parse → edit → template → email
  const [step, setStep] = useState<'pick_resume' | 'parse' | 'edit' | 'template' | 'email'>('pick_resume');
  const [resumeData, setResumeData] = useState<ResumeData>(emptyResume);
  const [template, setTemplate] = useState<TemplateName>('full_name');
  const [parsing, setParsing] = useState(false);
  const [resumeText, setResumeText] = useState('');
  const [selectedJobId, setSelectedJobId] = useState<string>('');
  const [jobPrompt, setJobPrompt] = useState('');
  const [usingExistingFormatted, setUsingExistingFormatted] = useState<any>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});

  // Email state
  const [emailTo, setEmailTo] = useState('');
  const [emailFrom, setEmailFrom] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [emailGreeting, setEmailGreeting] = useState('Hi,');
  const [generatingEmail, setGeneratingEmail] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachmentMode, setAttachmentMode] = useState<'generated' | 'existing'>('generated');

  // Resumes for this candidate
  const { data: resumes = [] } = useQuery({
    queryKey: ['resumes', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('resumes')
        .select('*')
        .eq('candidate_id', id!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Formatted resumes for this candidate
  const { data: formattedResumes = [] } = useQuery({
    queryKey: ['formatted_resumes', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('formatted_resumes')
        .select('*')
        .eq('candidate_id', id!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const selectedJob = jobs.find((j: any) => j.id === selectedJobId);

  // Job contacts
  const { data: jobContacts = [] } = useQuery({
    queryKey: ['job_contacts', selectedJobId],
    enabled: !!selectedJobId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('job_contacts')
        .select('contact_id, contacts(full_name, email)')
        .eq('job_id', selectedJobId);
      if (error) throw error;
      return data ?? [];
    },
  });

  // Pre-compute signed URLs for formatted resumes (private bucket)
  useEffect(() => {
    const paths = formattedResumes.map((r: any) => r.file_path).filter(Boolean) as string[];
    if (paths.length === 0) return;
    Promise.all(
      paths.map(async (p) => {
        const { data } = await supabase.storage.from('resumes').createSignedUrl(p, 3600);
        return [p, data?.signedUrl ?? null] as const;
      })
    ).then((results) => {
      const map: Record<string, string> = {};
      for (const [path, url] of results) {
        if (url) map[path] = url;
      }
      setSignedUrls(map);
    }).catch((err) => {
      console.error('Failed to sign resume URLs', err);
      toast.error('Failed to load resume links');
    });
  }, [formattedResumes]);

  // Pre-fill from candidate
  useEffect(() => {
    if (candidate) {
      const c = candidate as any;
      setResumeData(prev => ({
        ...prev,
        name: c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        email: c.email || '',
        phone: c.phone || '',
        linkedin: c.linkedin_url || '',
        location: c.location_text || c.location || '',
      }));
      if (c.job_id) setSelectedJobId(c.job_id);
    }
  }, [candidate]);

  // Default "from" to Chris Sullivan or current user
  useEffect(() => {
    if (profiles.length > 0 && !emailFrom) {
      const chris = profiles.find((p: any) => p.full_name?.toLowerCase().includes('chris'));
      setEmailFrom(chris?.email || user?.email || '');
    }
  }, [profiles, user]);

  // Pre-fill email when job selected — auto-populate ALL job contacts
  useEffect(() => {
    if (selectedJob && candidate) {
      const c = candidate as any;
      const name = c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim();
      setEmailSubject(`${name} | ${(selectedJob as any).title}`);

      // Pre-fill ALL contacts' emails
      const contactEmails = jobContacts
        .map((jc: any) => jc.contacts?.email)
        .filter(Boolean);
      if (contactEmails.length) setEmailTo(contactEmails.join(', '));
    }
  }, [selectedJob, candidate, jobContacts]);

  // Parse resume
  const handleParse = async (text: string) => {
    setParsing(true);
    setStep('parse');
    try {
      const resp = await fetch(`${BACKEND_URL}/api/parse-resume-ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resume_text: text,
          job_title: selectedJob?.title,
          job_description: (selectedJob as any)?.description || jobPrompt,
        }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      if (data.data) {
        setResumeData(prev => ({ ...prev, ...data.data }));
        toast.success('Resume parsed successfully');
        setStep('edit');
      } else {
        throw new Error('No data returned');
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to parse resume');
      setStep('pick_resume');
    } finally {
      setParsing(false);
    }
  };

  // Upload file
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // For now, read as text (works for txt). For PDF/DOCX, use existing parsed text from resumes
    if (file.type === 'text/plain') {
      const text = await file.text();
      setResumeText(text);
      handleParse(text);
    } else {
      toast.info('Processing file...');
      // Use the raw_text from an existing resume if available, or upload to Supabase for parsing
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        setResumeText(text);
        handleParse(text);
      };
      reader.readAsText(file);
    }
  };

  // Generate email
  const handleGenerateEmail = async () => {
    if (!candidate) return;
    setGeneratingEmail(true);
    try {
      const c = candidate as any;
      const contactNames = jobContacts.map((jc: any) => jc.contacts?.full_name).filter(Boolean);
      const resp = await fetch(`${BACKEND_URL}/api/generate-sendout-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidate_name: c.full_name || resumeData.name,
          candidate_title: c.current_title || resumeData.experience[0]?.title,
          candidate_company: c.current_company || resumeData.experience[0]?.company,
          candidate_notes: c.back_of_resume_notes || c.notes,
          compensation: c.target_total_comp ? `Target: $${c.target_total_comp}` : c.current_total_comp ? `Current: $${c.current_total_comp}` : undefined,
          job_title: selectedJob?.title,
          job_company: (selectedJob as any)?.company_name,
          job_description: (selectedJob as any)?.description,
          contact_names: contactNames,
          sender_name: user?.user_metadata?.display_name,
        }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      setEmailBody(data.body || '');
      setEmailGreeting(data.greeting || 'Hi,');
      toast.success('Email generated');
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate email');
    } finally {
      setGeneratingEmail(false);
    }
  };

  // Download PDF
  const handleDownloadPDF = () => {
    const doc = generatePDF(resumeData, template);
    const fileName = `${resumeData.name.replace(/\s+/g, '_')}_Resume.pdf`;
    doc.save(fileName);
    toast.success('PDF downloaded');
  };

  // Send email
  const handleSend = async () => {
    if (!emailTo || !emailBody) { toast.error('Recipient and body required'); return; }
    setSending(true);
    try {
      const senderProfile = profiles.find((p: any) => p.email === emailFrom);
      const senderName = senderProfile?.full_name || user?.user_metadata?.display_name || 'Emerald Recruiting';
      const fullEmail = `${emailGreeting}\n\n${emailBody}\n\nThanks,\n${senderName}`;

      // Send via edge function
      const { data, error } = await supabase.functions.invoke('send-message', {
        body: {
          channel: 'email',
          to: emailTo.split(',')[0].trim(),
          cc: emailTo.split(',').slice(1).map((e: string) => e.trim()).filter(Boolean).join(',') || undefined,
          subject: emailSubject,
          body: fullEmail,
          candidate_id: id,
          from_email: emailFrom || undefined,
        },
      });
      if (error) throw error;

      // Auto-save as formatted resume (if we generated a new one, not reusing existing)
      if (id && attachmentMode === 'generated') {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            const doc = generatePDF(resumeData, template);
            const pdfBlob = doc.output('blob');
            const fileName = `${resumeData.name.replace(/[^a-zA-Z0-9._-]/g, '_')}_Resume.pdf`;
            const path = `${session.user.id}/${id}/formatted/${Date.now()}_${fileName}`;
            await supabase.storage.from('resumes').upload(path, pdfBlob, { upsert: true, contentType: 'application/pdf' });
            await supabase.from('formatted_resumes').insert({
              candidate_id: id,
              file_name: fileName,
              file_path: path,
              mime_type: 'application/pdf',
              file_size: pdfBlob.size,
              version_label: selectedJob ? `${(selectedJob as any).title}` : `v${formattedResumes.length + 1}`,
              job_id: selectedJobId || null,
              created_by: session.user.id,
            } as any);
          }
        } catch (saveErr: any) {
          // Non-critical — email was sent, just log
          console.error('Failed to save formatted resume:', saveErr);
        }
      }

      // Update send_out stage or create send_out record.
      // Email already went out — DB failures here should be reported but not
      // block the post-send UI flow.
      const postSendWarnings: string[] = [];
      if (id && selectedJobId) {
        // Check if send_out exists for this candidate + job
        const { data: existingSO, error: existingErr } = await supabase
          .from('send_outs')
          .select('id, stage')
          .eq('candidate_id', id)
          .eq('job_id', selectedJobId)
          .limit(1)
          .maybeSingle();
        if (existingErr) {
          console.error('send_outs lookup failed:', existingErr);
          postSendWarnings.push('send-out lookup');
        } else if (existingSO) {
          // Advance to 'sent' if currently at new/reached_out/pitch/send_out
          if (['new', 'reached_out', 'pitch', 'send_out'].includes(existingSO.stage)) {
            const { error: updErr } = await supabase.from('send_outs').update({
              stage: 'sent',
              sent_to_client_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            } as any).eq('id', existingSO.id);
            if (updErr) {
              console.error('send_outs stage update failed:', updErr);
              postSendWarnings.push('send-out stage');
            }
          }
        } else {
          const { error: insErr } = await supabase.from('send_outs').insert({
            job_id: selectedJobId,
            candidate_id: id,
            stage: 'sent',
            recruiter_id: user?.id,
            sent_to_client_at: new Date().toISOString(),
          } as any);
          if (insErr) {
            console.error('send_outs insert failed:', insErr);
            postSendWarnings.push('send-out record');
          }
        }
      }

      // Update candidate status
      if (id) {
        const { error: candErr } = await supabase
          .from('candidates')
          .update({ job_status: 'send_out' } as any)
          .eq('id', id);
        if (candErr) {
          console.error('candidate status update failed:', candErr);
          postSendWarnings.push('candidate status');
        }
      }

      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['candidate', id] });
      queryClient.invalidateQueries({ queryKey: ['candidate_send_outs', id] });
      queryClient.invalidateQueries({ queryKey: ['formatted_resumes', id] });
      if (postSendWarnings.length > 0) {
        toast.warning(
          `Send-out email sent, but ${postSendWarnings.join(', ')} failed to update — check the record.`
        );
      } else {
        toast.success('Send-out email sent! Resume saved & status updated.');
      }
      navigate(`/candidates/${id}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  if (candLoading) {
    return <MainLayout><div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin" /></div></MainLayout>;
  }

  const c = candidate as any;
  const fullName = c?.full_name || `${c?.first_name || ''} ${c?.last_name || ''}`.trim() || 'Candidate';

  return (
    <MainLayout>
      {/* Header */}
      <div className="px-8 py-4 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/candidates/${id}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-foreground">Send Out — {fullName}</h1>
          <p className="text-sm text-muted-foreground">
            Format resume, generate email, send to client
          </p>
        </div>
        {/* Step indicator */}
        <div className="flex items-center gap-1">
          {['pick_resume', 'edit', 'template', 'email'].map((s, i) => (
            <div key={s} className={cn(
              'h-2 w-8 rounded-full transition-colors',
              step === s ? 'bg-accent' : i < ['pick_resume', 'edit', 'template', 'email'].indexOf(step) ? 'bg-accent/40' : 'bg-muted'
            )} />
          ))}
        </div>
      </div>

      <ScrollArea className="flex-1" style={{ height: 'calc(100vh - 10rem)' }}>
        <div className="p-8 max-w-4xl mx-auto">

          {/* ── Step 1: Pick Resume ────────────────────────────────── */}
          {step === 'pick_resume' && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold flex items-center gap-2"><FileText className="h-5 w-5 text-accent" /> Select Resume</h2>

              {/* Job selection */}
              <div className="space-y-2">
                <Label>Tag to Job <span className="text-muted-foreground">(required for send out)</span></Label>
                <Select value={selectedJobId || 'none'} onValueChange={(v) => setSelectedJobId(v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder="Select a job..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No job tagged</SelectItem>
                    {(jobs as any[]).filter(j => ['lead', 'hot', 'offer_made'].includes(j.status)).map(j => (
                      <SelectItem key={j.id} value={j.id}>{j.title}{j.company_name ? ` — ${j.company_name}` : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {!selectedJobId && (
                <div className="space-y-2">
                  <Label>Custom prompt (optional)</Label>
                  <Input value={jobPrompt} onChange={(e) => setJobPrompt(e.target.value)} placeholder="e.g., Tailor for VP of Engineering roles at fintech companies" />
                </div>
              )}

              {/* Existing formatted resumes — offer to reuse */}
              {formattedResumes.length > 0 && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <Check className="h-4 w-4 text-green-400" /> Existing Formatted Resumes
                  </Label>
                  <p className="text-xs text-muted-foreground">A formatted resume already exists. Use it or create a new one below.</p>
                  <div className="space-y-2">
                    {formattedResumes.map((r: any) => {
                      const url = r.file_path ? signedUrls[r.file_path] : null;
                      return (
                        <button
                          key={r.id}
                          onClick={() => {
                            setUsingExistingFormatted(r);
                            setAttachmentMode('existing');
                            setStep('email');
                            handleGenerateEmail();
                          }}
                          className="w-full flex items-center gap-3 rounded-lg border-2 border-green-500/30 bg-green-500/5 p-3 hover:border-green-500/60 transition-colors text-left"
                        >
                          <FileText className="h-5 w-5 text-green-400 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{r.file_name || 'Formatted Resume'}</p>
                            <p className="text-xs text-muted-foreground">
                              {r.version_label && <span className="mr-2 text-accent">{r.version_label}</span>}
                              {r.file_size && <span className="mr-2">{(r.file_size / 1024).toFixed(0)} KB</span>}
                              {r.created_at && format(new Date(r.created_at), 'MMM d, yyyy')}
                            </p>
                          </div>
                          <Badge variant="secondary" className="text-[10px] shrink-0">Use This</Badge>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Existing resumes from files */}
              {resumes.length > 0 && (
                <div className="space-y-2">
                  <Label>Resumes on File</Label>
                  <p className="text-xs text-muted-foreground">Select a resume to auto-format with Emerald branding.</p>
                  <div className="space-y-2">
                    {resumes.map((r: any) => (
                      <button
                        key={r.id}
                        onClick={() => {
                          setAttachmentMode('generated');
                          setUsingExistingFormatted(null);
                          const text = r.raw_text || r.ai_summary || '';
                          if (text) { setResumeText(text); handleParse(text); }
                          else toast.error('No resume text available — re-upload the file');
                        }}
                        className="w-full flex items-center gap-3 rounded-lg border border-border p-3 hover:border-accent/50 transition-colors text-left"
                      >
                        <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{r.file_name || 'Resume'}</p>
                          <p className="text-xs text-muted-foreground">
                            {r.file_size && <span className="mr-2">{(r.file_size / 1024).toFixed(0)} KB</span>}
                            {r.created_at ? format(new Date(r.created_at), 'MMM d, yyyy') : ''}
                          </p>
                        </div>
                        <span className="text-xs text-accent shrink-0">Format →</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Upload new */}
              <div className="space-y-2">
                <Label>Or upload a new resume</Label>
                <label className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border p-8 cursor-pointer hover:border-accent/50 transition-colors">
                  <Upload className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">Click to upload PDF, DOCX, or TXT</p>
                  <input type="file" accept=".pdf,.docx,.doc,.txt" className="hidden" onChange={handleFileUpload} />
                </label>
              </div>

              {/* Manual paste */}
              <div className="space-y-2">
                <Label>Or paste resume text</Label>
                <Textarea
                  rows={6}
                  value={resumeText}
                  onChange={(e) => setResumeText(e.target.value)}
                  placeholder="Paste resume content here..."
                />
                {resumeText && (
                  <Button variant="gold" onClick={() => { setAttachmentMode('generated'); setUsingExistingFormatted(null); handleParse(resumeText); }}>
                    <Sparkles className="h-4 w-4 mr-1" /> Parse with AI
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* ── Step: Parsing ─────────────────────────────────────── */}
          {step === 'parse' && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <Loader2 className="h-10 w-10 animate-spin text-accent" />
              <p className="text-sm text-muted-foreground">AI is parsing the resume...</p>
            </div>
          )}

          {/* ── Step 2: Edit Resume ───────────────────────────────── */}
          {step === 'edit' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold flex items-center gap-2"><Edit className="h-5 w-5 text-accent" /> Edit Resume</h2>
                <Button variant="gold" onClick={() => setStep('template')}>Next: Choose Template <ArrowRight className="h-4 w-4 ml-1" /></Button>
              </div>

              {/* Personal */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5"><Label>Full Name</Label><Input value={resumeData.name} onChange={(e) => setResumeData(d => ({ ...d, name: e.target.value }))} /></div>
                <div className="space-y-1.5"><Label>Email</Label><Input value={resumeData.email} onChange={(e) => setResumeData(d => ({ ...d, email: e.target.value }))} /></div>
                <div className="space-y-1.5"><Label>Phone</Label><Input value={resumeData.phone} onChange={(e) => setResumeData(d => ({ ...d, phone: e.target.value }))} /></div>
                <div className="space-y-1.5"><Label>Location</Label><Input value={resumeData.location} onChange={(e) => setResumeData(d => ({ ...d, location: e.target.value }))} /></div>
              </div>
              <div className="space-y-1.5"><Label>Summary</Label><Textarea rows={3} value={resumeData.summary} onChange={(e) => setResumeData(d => ({ ...d, summary: e.target.value }))} /></div>

              {/* Experience */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold flex items-center gap-1.5"><Briefcase className="h-4 w-4" /> Experience</h3>
                  <Button variant="outline" size="sm" onClick={() => setResumeData(d => ({ ...d, experience: [...d.experience, { company: '', title: '', start_date: '', end_date: '', duration: '', responsibilities: [''] }] }))}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add
                  </Button>
                </div>
                {resumeData.experience.map((exp, i) => (
                  <div key={i} className="rounded-lg border border-border p-4 mb-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-muted-foreground">Experience {i + 1}</span>
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => setResumeData(d => ({ ...d, experience: d.experience.filter((_, j) => j !== i) }))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Input placeholder="Company" value={exp.company} onChange={(e) => { const n = [...resumeData.experience]; n[i] = { ...n[i], company: e.target.value }; setResumeData(d => ({ ...d, experience: n })); }} />
                      <Input placeholder="Title" value={exp.title} onChange={(e) => { const n = [...resumeData.experience]; n[i] = { ...n[i], title: e.target.value }; setResumeData(d => ({ ...d, experience: n })); }} />
                      <Input placeholder="Start" value={exp.start_date} onChange={(e) => { const n = [...resumeData.experience]; n[i] = { ...n[i], start_date: e.target.value }; setResumeData(d => ({ ...d, experience: n })); }} />
                      <Input placeholder="End" value={exp.end_date} onChange={(e) => { const n = [...resumeData.experience]; n[i] = { ...n[i], end_date: e.target.value }; setResumeData(d => ({ ...d, experience: n })); }} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Responsibilities</Label>
                      {exp.responsibilities.map((r, ri) => (
                        <div key={ri} className="flex gap-1">
                          <Input value={r} onChange={(e) => { const n = [...resumeData.experience]; n[i].responsibilities[ri] = e.target.value; setResumeData(d => ({ ...d, experience: n })); }} className="text-xs h-8" />
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive" onClick={() => { const n = [...resumeData.experience]; n[i].responsibilities = n[i].responsibilities.filter((_, j) => j !== ri); setResumeData(d => ({ ...d, experience: n })); }}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                      <Button variant="ghost" size="sm" className="text-xs" onClick={() => { const n = [...resumeData.experience]; n[i].responsibilities.push(''); setResumeData(d => ({ ...d, experience: n })); }}>
                        <Plus className="h-3 w-3 mr-1" /> Add bullet
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Education */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold flex items-center gap-1.5"><GraduationCap className="h-4 w-4" /> Education</h3>
                  <Button variant="outline" size="sm" onClick={() => setResumeData(d => ({ ...d, education: [...d.education, { institution: '', degree: '', field: '', year: '' }] }))}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add
                  </Button>
                </div>
                {resumeData.education.map((edu, i) => (
                  <div key={i} className="flex items-center gap-3 mb-2">
                    <Input placeholder="Institution" value={edu.institution} onChange={(e) => { const n = [...resumeData.education]; n[i] = { ...n[i], institution: e.target.value }; setResumeData(d => ({ ...d, education: n })); }} />
                    <Input placeholder="Degree" value={edu.degree} onChange={(e) => { const n = [...resumeData.education]; n[i] = { ...n[i], degree: e.target.value }; setResumeData(d => ({ ...d, education: n })); }} />
                    <Input placeholder="Field" value={edu.field} onChange={(e) => { const n = [...resumeData.education]; n[i] = { ...n[i], field: e.target.value }; setResumeData(d => ({ ...d, education: n })); }} />
                    <Input placeholder="Year" value={edu.year} onChange={(e) => { const n = [...resumeData.education]; n[i] = { ...n[i], year: e.target.value }; setResumeData(d => ({ ...d, education: n })); }} className="w-24" />
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive" onClick={() => setResumeData(d => ({ ...d, education: d.education.filter((_, j) => j !== i) }))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>

              {/* Skills */}
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5"><Wrench className="h-4 w-4" /> Skills (comma separated)</Label>
                <Input value={resumeData.skills.join(', ')} onChange={(e) => setResumeData(d => ({ ...d, skills: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} />
              </div>

              <div className="space-y-1.5">
                <Label>Technical Systems (comma separated)</Label>
                <Input value={resumeData.technical_systems.join(', ')} onChange={(e) => setResumeData(d => ({ ...d, technical_systems: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} />
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5"><Award className="h-4 w-4" /> Certifications (comma separated)</Label>
                <Input value={resumeData.certifications.join(', ')} onChange={(e) => setResumeData(d => ({ ...d, certifications: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} />
              </div>
            </div>
          )}

          {/* ── Step 3: Template Selection ────────────────────────── */}
          {step === 'template' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold flex items-center gap-2"><Eye className="h-5 w-5 text-accent" /> Choose Template</h2>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setStep('edit')}><ArrowLeft className="h-4 w-4 mr-1" /> Back to Edit</Button>
                  <Button variant="gold" onClick={() => { setStep('email'); handleGenerateEmail(); }}>Next: Email <ArrowRight className="h-4 w-4 ml-1" /></Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => setTemplate(t.value)}
                    className={cn(
                      'rounded-lg border-2 p-4 text-left transition-all',
                      template === t.value ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/40'
                    )}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold">{t.label}</span>
                      {template === t.value && <Check className="h-4 w-4 text-accent" />}
                    </div>
                    <p className="text-xs text-muted-foreground">{t.desc}</p>
                  </button>
                ))}
              </div>

              <Button variant="outline" onClick={handleDownloadPDF} className="w-full gap-2">
                <Download className="h-4 w-4" /> Preview & Download PDF
              </Button>
            </div>
          )}

          {/* ── Step 4: Email ─────────────────────────────────────── */}
          {step === 'email' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold flex items-center gap-2"><Mail className="h-5 w-5 text-accent" /> Send Out Email</h2>
                <Button variant="outline" onClick={() => usingExistingFormatted ? setStep('pick_resume') : setStep('template')}>
                  <ArrowLeft className="h-4 w-4 mr-1" /> Back
                </Button>
              </div>

              <div className="space-y-4">
                {/* From */}
                <div className="space-y-1.5">
                  <Label>From</Label>
                  <Select value={emailFrom} onValueChange={setEmailFrom}>
                    <SelectTrigger><SelectValue placeholder="Select sender..." /></SelectTrigger>
                    <SelectContent>
                      {profiles.filter((p: any) => p.email).map((p: any) => (
                        <SelectItem key={p.id} value={p.email}>{p.full_name} ({p.email})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* To */}
                <div className="space-y-1.5">
                  <Label>To (comma separated — all job contacts auto-added)</Label>
                  <Input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="client@company.com" />
                  {jobContacts.length > 0 && (
                    <div className="flex gap-1 flex-wrap mt-1">
                      {jobContacts.map((jc: any) => jc.contacts?.email && (
                        <button key={jc.contact_id} onClick={() => {
                          const current = emailTo.split(',').map(e => e.trim()).filter(Boolean);
                          if (!current.includes(jc.contacts.email)) {
                            setEmailTo(prev => prev ? `${prev}, ${jc.contacts.email}` : jc.contacts.email);
                          }
                        }} className={cn(
                          'text-[10px] px-2 py-0.5 rounded border transition-colors',
                          emailTo.includes(jc.contacts.email)
                            ? 'border-accent/50 bg-accent/10 text-accent'
                            : 'border-border hover:border-accent/50 text-muted-foreground'
                        )}>
                          {emailTo.includes(jc.contacts.email) ? '✓' : '+'} {jc.contacts.full_name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Subject */}
                <div className="space-y-1.5">
                  <Label>Subject</Label>
                  <Input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} />
                </div>

                {/* Email body */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>Email Body</Label>
                    <Button variant="ghost" size="sm" onClick={handleGenerateEmail} disabled={generatingEmail} className="text-xs gap-1">
                      {generatingEmail ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                      {generatingEmail ? 'Ask Joe is writing...' : 'Ask Joe to Write'}
                    </Button>
                  </div>
                  {generatingEmail ? (
                    <div className="rounded-lg border border-accent/30 bg-accent/5 p-6 flex items-center gap-3">
                      <Loader2 className="h-5 w-5 animate-spin text-accent" />
                      <span className="text-sm text-muted-foreground">Joe is crafting the perfect send-out email in the Emerald voice...</span>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border p-4 space-y-2 bg-card">
                      <Input value={emailGreeting} onChange={(e) => setEmailGreeting(e.target.value)} className="border-0 p-0 h-auto text-sm font-medium focus-visible:ring-0" />
                      <Textarea rows={8} value={emailBody} onChange={(e) => setEmailBody(e.target.value)} className="border-0 p-0 resize-none focus-visible:ring-0 text-sm" />
                      <p className="text-sm text-muted-foreground">
                        Thanks,<br />
                        {profiles.find((p: any) => p.email === emailFrom)?.full_name || user?.user_metadata?.display_name || 'Emerald Recruiting'}
                      </p>
                    </div>
                  )}
                </div>

                {/* Attachment */}
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-1.5"><FileText className="h-4 w-4 text-accent" /> Attachment</Label>
                    <Button variant="ghost" size="sm" className="text-xs" onClick={() => {
                      setAttachmentMode(attachmentMode === 'generated' ? 'existing' : 'generated');
                      if (attachmentMode === 'generated' && formattedResumes.length > 0) {
                        setUsingExistingFormatted(formattedResumes[0]);
                      } else {
                        setUsingExistingFormatted(null);
                      }
                    }}>
                      Change Attachment
                    </Button>
                  </div>

                  {attachmentMode === 'existing' && usingExistingFormatted ? (
                    <div className="flex items-center gap-3 rounded-md bg-green-500/5 border border-green-500/20 p-3">
                      <FileText className="h-5 w-5 text-green-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{usingExistingFormatted.file_name}</p>
                        <p className="text-xs text-muted-foreground">
                          Existing formatted resume
                          {usingExistingFormatted.version_label && <span className="ml-1 text-accent">({usingExistingFormatted.version_label})</span>}
                        </p>
                      </div>
                      {usingExistingFormatted.file_path && (
                        <a
                          href={signedUrls[usingExistingFormatted.file_path] || '#'}
                          target="_blank" rel="noreferrer"
                          className="text-xs text-accent hover:underline shrink-0"
                        >
                          Preview
                        </a>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 rounded-md bg-accent/5 border border-accent/20 p-3">
                      <FileText className="h-5 w-5 text-accent shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{resumeData.name.replace(/\s+/g, '_')}_Resume.pdf</p>
                        <p className="text-xs text-muted-foreground">
                          Newly formatted • {TEMPLATES.find(t => t.value === template)?.label} template
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" className="text-xs shrink-0" onClick={handleDownloadPDF}>
                        <Download className="h-3.5 w-3.5 mr-1" /> Preview
                      </Button>
                    </div>
                  )}

                  {/* Quick swap between formatted resumes */}
                  {formattedResumes.length > 0 && attachmentMode === 'existing' && (
                    <div className="space-y-1">
                      {formattedResumes.filter((r: any) => r.id !== usingExistingFormatted?.id).map((r: any) => (
                        <button key={r.id} onClick={() => setUsingExistingFormatted(r)}
                          className="w-full flex items-center gap-2 rounded border border-border p-2 hover:border-accent/40 text-left text-xs">
                          <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="truncate">{r.file_name}</span>
                          {r.version_label && <Badge variant="secondary" className="text-[9px] shrink-0">{r.version_label}</Badge>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Send */}
                <Button variant="gold" onClick={handleSend} disabled={sending || !emailTo || !emailBody} className="w-full gap-2">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {sending ? 'Sending & Saving...' : 'Send Email, Save Resume & Update Pipeline'}
                </Button>
              </div>
            </div>
          )}

        </div>
      </ScrollArea>
    </MainLayout>
  );
}
