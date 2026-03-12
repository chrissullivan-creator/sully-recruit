import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AddContactDialog } from '@/components/contacts/AddContactDialog';
import { TaskSlidePanel } from '@/components/tasks/TaskSlidePanel';
import { SendOutPipeline } from '@/components/pipeline/SendOutPipeline';
import { EditJobDialog } from '@/components/jobs/EditJobDialog';
import { useJob, useContacts, useJobSendOuts, useJobCandidates } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useMemo, useState } from 'react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import {
  ArrowLeft, Briefcase, MapPin, DollarSign, UserPlus, ListTodo, Loader2, Edit, Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const JOB_STATUSES = [
  { value: 'pitched',      label: 'Pitched',      color: 'bg-blue-500/15 text-blue-400' },
  { value: 'send_out',     label: 'Send Out',     color: 'bg-yellow-500/15 text-yellow-400' },
  { value: 'submitted',    label: 'Submitted',    color: 'bg-purple-500/15 text-purple-400' },
  { value: 'interviewing', label: 'Interviewing', color: 'bg-orange-500/15 text-orange-400' },
  { value: 'offer',        label: 'Offer',        color: 'bg-emerald-500/15 text-emerald-400' },
  { value: 'placed',       label: 'Placed',       color: 'bg-green-500/15 text-green-400' },
  { value: 'rejected',     label: 'Rejected',     color: 'bg-red-500/15 text-red-400' },
  { value: 'withdrew',     label: 'Withdrew',     color: 'bg-muted text-muted-foreground' },
];

const JobDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: job, isLoading } = useJob(id);
  const { data: contacts = [] } = useContacts();
  const { data: sendOuts = [] } = useJobSendOuts(id);
  const { data: jobCandidates = [], isLoading: candidatesLoading } = useJobCandidates(id);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [editJobOpen, setEditJobOpen] = useState(false);

  // Sort contacts: company contacts first
  const sortedContacts = useMemo(() => {
    if (!job?.company_id) return contacts;
    return [...contacts].sort((a: any, b: any) => {
      const aMatch = a.company_id === job.company_id ? 0 : 1;
      const bMatch = b.company_id === job.company_id ? 0 : 1;
      return aMatch - bMatch;
    });
  }, [contacts, job?.company_id]);

  const companyContactIds = useMemo(() => {
    if (!job?.company_id) return new Set<string>();
    return new Set(contacts.filter((c: any) => c.company_id === job.company_id).map((c: any) => c.id));
  }, [contacts, job?.company_id]);

  const assignContact = async () => {
    if (!selectedContactId || !id) return;
    setAssigning(true);
    try {
      const { error } = await supabase
        .from('jobs')
        .update({ contact_id: selectedContactId })
        .eq('id', id);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast.success('Contact assigned to job');
      setSelectedContactId('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to assign contact');
    } finally {
      setAssigning(false);
    }
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="p-8 text-muted-foreground">Loading job...</div>
      </MainLayout>
    );
  }

  if (!job) {
    return (
      <MainLayout>
        <div className="p-8 text-muted-foreground">Job not found.</div>
      </MainLayout>
    );
  }

  const companyName = job.company_name ?? (job.companies as any)?.name ?? null;
  const currentContact = contacts.find((c: any) => c.id === job.contact_id);

  return (
    <MainLayout>
      <PageHeader
        title={job.title}
        description={companyName ? `at ${companyName}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate('/jobs')}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditJobOpen(true)}>
              <Edit className="h-4 w-4 mr-1" />
              Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setTaskPanel(true)}>
              <ListTodo className="h-4 w-4 mr-1" />
              Tasks
            </Button>
          </div>
        }
      />

      <div className="p-8 space-y-6 max-w-4xl">
        {/* Job Info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Briefcase className="h-5 w-5 text-accent" />
              Job Details
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Status</span>
                <div className="mt-1">
                  <Badge variant="secondary">{job.status}</Badge>
                </div>
              </div>
              {companyName && (
                <div>
                  <span className="text-muted-foreground">Company</span>
                  <p className="mt-1 font-medium text-foreground">{companyName}</p>
                </div>
              )}
              {job.location && (
                <div>
                  <span className="text-muted-foreground flex items-center gap-1"><MapPin className="h-3 w-3" /> Location</span>
                  <p className="mt-1 font-medium text-foreground">{job.location}</p>
                </div>
              )}
              {job.compensation && (
                <div>
                  <span className="text-muted-foreground flex items-center gap-1"><DollarSign className="h-3 w-3" /> Compensation</span>
                  <p className="mt-1 font-medium text-foreground">{job.compensation}</p>
                </div>
              )}
            </div>
            {job.description && (
              <div className="mt-4">
                <span className="text-sm text-muted-foreground">Description</span>
                <p className="mt-1 text-sm text-foreground whitespace-pre-wrap">{job.description}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Current Contact */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-accent" />
              Job Contact
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {currentContact ? (
              <div className="rounded-lg border border-border p-3 text-sm">
                <p className="font-medium text-foreground">{currentContact.full_name}</p>
                {currentContact.title && <p className="text-muted-foreground">{currentContact.title}</p>}
                {currentContact.email && <p className="text-muted-foreground">{currentContact.email}</p>}
                {currentContact.phone && <p className="text-muted-foreground">{currentContact.phone}</p>}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No contact assigned yet.</p>
            )}

            <div className="flex items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label className="text-sm">Assign Existing Contact</Label>
                <Select value={selectedContactId || 'none'} onValueChange={(v) => setSelectedContactId(v === 'none' ? '' : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a contact" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Select a contact</SelectItem>
                    {companyContactIds.size > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                          {companyName ?? 'Company'} Contacts
                        </div>
                        {sortedContacts
                          .filter((c: any) => companyContactIds.has(c.id))
                          .map((c: any) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.full_name}{c.title ? ` — ${c.title}` : ''}
                            </SelectItem>
                          ))}
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground border-t border-border mt-1 pt-1.5">
                          Other Contacts
                        </div>
                      </>
                    )}
                    {sortedContacts
                      .filter((c: any) => !companyContactIds.has(c.id))
                      .map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.full_name}{c.title ? ` — ${c.title}` : ''}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="gold"
                onClick={assignContact}
                disabled={!selectedContactId || assigning}
              >
                {assigning && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                Assign
              </Button>
            </div>

            <div className="pt-2 border-t border-border">
              <Button variant="outline" size="sm" onClick={() => setAddContactOpen(true)}>
                <UserPlus className="h-4 w-4 mr-1" />
                Create New Contact
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Linked Candidates */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className="h-5 w-5 text-accent" />
              Candidates
              {jobCandidates.length > 0 && (
                <Badge variant="secondary" className="ml-1">{jobCandidates.length}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {candidatesLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading candidates...
              </div>
            ) : jobCandidates.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No candidates linked yet. Enroll candidates in a sequence tagged to this job.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {(jobCandidates as any[]).map((c) => {
                  const statusCfg = JOB_STATUSES.find(s => s.value === c.job_status);
                  return (
                    <div
                      key={c.id}
                      className="flex items-center justify-between py-3 gap-4"
                    >
                      <div
                        className="flex-1 min-w-0 cursor-pointer"
                        onClick={() => navigate(`/candidates/${c.id}`)}
                      >
                        <p className="text-sm font-medium text-foreground hover:text-accent truncate">
                          {c.full_name}
                        </p>
                        {(c.current_title || c.current_company) && (
                          <p className="text-xs text-muted-foreground truncate">
                            {c.current_title}{c.current_title && c.current_company ? ' at ' : ''}{c.current_company}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0">
                        {statusCfg ? (
                          <span className={cn('px-2 py-0.5 rounded text-xs font-medium', statusCfg.color)}>
                            {statusCfg.label}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
                            No status
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Candidates tagged to this job */}
        <SendOutPipeline
          title="Candidates for This Role"
          sendOuts={sendOuts}
          isLoading={isLoading}
        />
      </div>

      <AddContactDialog open={addContactOpen} onOpenChange={setAddContactOpen} />
      {taskPanel && (
        <TaskSlidePanel
          open={taskPanel}
          onOpenChange={setTaskPanel}
          entityType="job"
          entityId={job.id}
          entityName={job.title}
        />
      )}
      <EditJobDialog open={editJobOpen} onOpenChange={setEditJobOpen} job={job} />
    </MainLayout>
  );
};

export default JobDetail;
