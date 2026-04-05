import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TaskSidebar } from '@/components/tasks/TaskSidebar';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState, useRef, useEffect } from 'react';
import {
  ArrowLeft, Building, Globe, MapPin, Briefcase, FileText, Upload,
  Loader2, ExternalLink, Edit, Check, X, Linkedin, Users, Info, Plus,
  FolderOpen,
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

const EditableField = ({ label, value, onSave, type = 'text', placeholder }: {
  label: string; value: string | null | undefined; onSave: (v: string) => Promise<void>;
  type?: string; placeholder?: string;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  const save = async () => { setSaving(true); await onSave(draft); setSaving(false); setEditing(false); };
  const cancel = () => { setDraft(value ?? ''); setEditing(false); };
  return (
    <div className="group space-y-0.5">
      <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</Label>
      {editing ? (
        <div className="flex items-center gap-1">
          <Input ref={inputRef} type={type} value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
            className="h-7 text-sm flex-1" placeholder={placeholder} />
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 text-green-400" />}
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={cancel}>
            <X className="h-3 w-3 text-red-400" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 hover:bg-accent/10 transition-colors" onClick={() => setEditing(true)}>
          <span className={cn('text-sm flex-1 truncate', value ? 'text-foreground' : 'text-muted-foreground italic')}>
            {value || placeholder || '—'}
          </span>
          <Edit className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
        </div>
      )}
    </div>
  );
};

const CompanyDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const contractInputRef = useRef<HTMLInputElement>(null);
  const [uploadingContract, setUploadingContract] = useState(false);

  const { data: company, isLoading } = useQuery({
    queryKey: ['company', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies')
        .select('*')
        .eq('id', id!)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });

  const { data: companyJobs = [] } = useQuery({
    queryKey: ['company_jobs', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('jobs')
        .select('*')
        .eq('company_id', id!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const { data: contracts = [] } = useQuery({
    queryKey: ['company_contracts', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('company_contracts')
        .select('*')
        .eq('company_id', id!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const { data: contacts = [] } = useQuery({
    queryKey: ['company_contacts', id],
    enabled: !!id && !!company?.name,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('company_name', company!.name)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data as any[];
    },
  });

  const updateField = async (field: string, value: string) => {
    if (!id) return;
    const { error } = await supabase.from('companies').update({ [field]: value || null }).eq('id', id);
    if (error) { toast.error('Failed to update'); return; }
    queryClient.invalidateQueries({ queryKey: ['company', id] });
    queryClient.invalidateQueries({ queryKey: ['companies'] });
  };

  const handleContractUpload = async (file: File) => {
    if (!id) return;
    setUploadingContract(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const path = `companies/${id}/contracts/${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
      const { error: upErr } = await supabase.storage.from('resumes').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const { error: dbErr } = await supabase.from('company_contracts').insert({
        company_id: id,
        file_name: file.name,
        file_path: path,
        mime_type: file.type || 'application/pdf',
        file_size: file.size,
        created_by: session.user.id,
      } as any);
      if (dbErr) throw dbErr;
      queryClient.invalidateQueries({ queryKey: ['company_contracts', id] });
      toast.success('Contract uploaded');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setUploadingContract(false);
    }
  };

  if (isLoading) return <MainLayout><div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div></MainLayout>;
  if (!company) return <MainLayout><div className="flex items-center justify-center h-full"><p className="text-muted-foreground">Company not found.</p></div></MainLayout>;

  return (
    <MainLayout>
      <div className="flex items-center gap-3 px-8 py-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => navigate('/companies')}><ArrowLeft className="h-4 w-4" /></Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-foreground">{company.name}</h1>
          <p className="text-sm text-muted-foreground">
            {company.industry && <span>{company.industry}</span>}
            {company.industry && company.location && <span> &middot; </span>}
            {company.location && <span>{company.location}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {company.company_type && (
            <Badge variant="secondary" className={cn(
              'text-xs',
              company.company_type === 'client' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
            )}>
              {company.company_type}
            </Badge>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-72 shrink-0 border-r border-border overflow-y-auto">
          <div className="p-5 space-y-5">
            <div className="flex flex-col items-center text-center">
              {(company as any).logo_url ? (
                <img src={(company as any).logo_url} alt={company.name} className="h-14 w-14 rounded-full object-cover mb-2" />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-lg font-semibold text-accent mb-2">
                  <Building className="h-6 w-6" />
                </div>
              )}
            </div>

            <div className="space-y-3">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Company Info</h3>
              <EditableField label="Name" value={company.name} onSave={v => updateField('name', v)} />
              <EditableField label="Industry" value={company.industry} onSave={v => updateField('industry', v)} placeholder="e.g. Financial Services" />
              <EditableField label="Size" value={company.size} onSave={v => updateField('size', v)} placeholder="e.g. 500-1000" />
              <EditableField label="Location" value={company.location} onSave={v => updateField('location', v)} placeholder="City, State" />
              <EditableField label="HQ Location" value={company.hq_location} onSave={v => updateField('hq_location', v)} placeholder="Headquarters" />
            </div>

            <div className="space-y-3">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Online</h3>
              <EditableField label="Domain" value={company.domain} onSave={v => updateField('domain', v)} placeholder="company.com" />
              <EditableField label="Website" value={company.website} onSave={v => updateField('website', v)} placeholder="https://..." />
              <EditableField label="LinkedIn" value={company.linkedin_url} onSave={v => updateField('linkedin_url', v)} placeholder="https://linkedin.com/company/..." />
            </div>

            <div className="space-y-2">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Type</h3>
              <Select value={company.company_type ?? 'none'} onValueChange={async (val) => {
                const newType = val === 'none' ? null : val;
                await supabase.from('companies').update({ company_type: newType }).eq('id', id!);
                queryClient.invalidateQueries({ queryKey: ['company', id] });
                queryClient.invalidateQueries({ queryKey: ['companies'] });
                toast.success('Type updated');
              }}>
                <SelectTrigger className="h-7 text-xs w-full"><SelectValue placeholder="Set type..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  <SelectItem value="client">Client</SelectItem>
                  <SelectItem value="target">Target</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <EditableField label="Description" value={company.description} onSave={v => updateField('description', v)} placeholder="About this company..." />

            <p className="text-[10px] text-muted-foreground">Added {format(new Date(company.created_at), 'MMM d, yyyy')}</p>
          </div>
        </aside>

        <div className="flex-1 flex flex-col overflow-hidden">
          <Tabs defaultValue="jobs" className="flex-1 flex flex-col overflow-hidden">
            <div className="px-8 pt-4 border-b border-border">
              <TabsList className="bg-secondary">
                <TabsTrigger value="jobs" className="gap-1.5"><Briefcase className="h-3.5 w-3.5" /> Jobs</TabsTrigger>
                <TabsTrigger value="contacts" className="gap-1.5"><Users className="h-3.5 w-3.5" /> Contacts</TabsTrigger>
                <TabsTrigger value="contracts" className="gap-1.5"><FolderOpen className="h-3.5 w-3.5" /> Contracts</TabsTrigger>
              </TabsList>
            </div>

            <ScrollArea className="flex-1">
              {/* Jobs tab */}
              <TabsContent value="jobs" className="px-8 py-5 mt-0 space-y-4">
                <div className="flex items-center gap-2">
                  <Briefcase className="h-5 w-5 text-accent" />
                  <h2 className="text-base font-semibold">Jobs</h2>
                  <span className="text-xs text-muted-foreground">({companyJobs.length})</span>
                </div>
                {companyJobs.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <Briefcase className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium mb-1">No jobs yet</p>
                    <p className="text-xs text-muted-foreground">Jobs linked to this company will appear here.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {companyJobs.map((job: any) => (
                      <div
                        key={job.id}
                        className="rounded-lg border border-border bg-secondary/30 p-4 hover:border-accent/40 cursor-pointer transition-colors"
                        onClick={() => navigate(`/jobs/${job.id}`)}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-foreground">{job.title}</p>
                            <p className="text-xs text-muted-foreground">
                              {job.location && <span>{job.location} &middot; </span>}
                              {job.created_at && format(new Date(job.created_at), 'MMM d, yyyy')}
                            </p>
                          </div>
                          {job.status && (
                            <Badge variant="secondary" className="text-xs capitalize">{job.status}</Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Contacts tab */}
              <TabsContent value="contacts" className="px-8 py-5 mt-0 space-y-4">
                <div className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-accent" />
                  <h2 className="text-base font-semibold">Contacts</h2>
                  <span className="text-xs text-muted-foreground">({contacts.length})</span>
                </div>
                {contacts.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium mb-1">No contacts</p>
                    <p className="text-xs text-muted-foreground">Contacts at this company will appear here.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {contacts.map((ct: any) => (
                      <div key={ct.id} className="rounded-lg border border-border bg-secondary/30 p-3">
                        <p className="text-sm font-medium text-foreground">{ct.full_name || `${ct.first_name ?? ''} ${ct.last_name ?? ''}`.trim() || 'Unknown'}</p>
                        <p className="text-xs text-muted-foreground">
                          {ct.title && <span>{ct.title}</span>}
                          {ct.email && <span className="ml-2">{ct.email}</span>}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Contracts tab */}
              <TabsContent value="contracts" className="px-8 py-5 mt-0 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="h-5 w-5 text-accent" />
                    <h2 className="text-base font-semibold">Contracts</h2>
                    <span className="text-xs text-muted-foreground">({contracts.length})</span>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => contractInputRef.current?.click()} disabled={uploadingContract}>
                    {uploadingContract ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
                    Upload Contract
                  </Button>
                  <input ref={contractInputRef} type="file" accept=".pdf,.doc,.docx,.xlsx,.csv" className="hidden"
                    onChange={e => { const file = e.target.files?.[0]; if (file) handleContractUpload(file); e.target.value = ''; }} />
                </div>
                {contracts.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <FileText className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium mb-1">No contracts yet</p>
                    <p className="text-xs text-muted-foreground mb-4">Upload contracts, agreements, or SOWs for this company.</p>
                    <Button variant="outline" size="sm" onClick={() => contractInputRef.current?.click()}>
                      <Upload className="h-3.5 w-3.5 mr-1" /> Upload Contract
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {contracts.map((ct: any) => {
                      const downloadUrl = ct.file_path ? supabase.storage.from('resumes').getPublicUrl(ct.file_path).data?.publicUrl : null;
                      return (
                        <div key={ct.id} className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <FileText className="h-4 w-4 text-accent shrink-0" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">{ct.file_name}</p>
                              <p className="text-xs text-muted-foreground">
                                {ct.contract_type && <span className="mr-2 capitalize">{ct.contract_type}</span>}
                                {ct.file_size && <span className="mr-2">{(ct.file_size / 1024).toFixed(0)} KB</span>}
                                {ct.created_at && format(new Date(ct.created_at), 'MMM d, yyyy')}
                                {ct.status && <Badge variant="secondary" className="ml-2 text-[9px]">{ct.status}</Badge>}
                              </p>
                            </div>
                          </div>
                          {downloadUrl && (
                            <a href={downloadUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline text-sm flex items-center gap-1 shrink-0">
                              <ExternalLink className="h-3.5 w-3.5" /> View
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </TabsContent>
            </ScrollArea>
          </Tabs>
        </div>

        {id && (
          <div className="w-72 shrink-0 border-l border-border p-4 overflow-y-auto">
            <TaskSidebar entityType="company" entityId={id} />
          </div>
        )}
      </div>
    </MainLayout>
  );
};

export default CompanyDetail;
