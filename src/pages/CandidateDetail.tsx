import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { useCandidate, useNotes, useCandidateConversations } from '@/hooks/useSupabaseData';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState } from 'react';
import {
  ArrowLeft, Mail, Phone, Linkedin, Building, MapPin, Calendar,
  Edit, MoreHorizontal, Briefcase, MessageSquare, History, User, Play,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

const CandidateDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: candidate, isLoading } = useCandidate(id);
  const { data: notes = [] } = useNotes(id, 'candidate');
  const { data: conversations = [] } = useCandidateConversations(id);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </MainLayout>
    );
  }

  if (!candidate) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground">Candidate not found.</p>
        </div>
      </MainLayout>
    );
  }

  const handleSaveNote = async () => {
    if (!noteText.trim() || !id) return;
    setSaving(true);
    const { error } = await supabase.from('notes').insert({
      entity_id: id,
      entity_type: 'candidate',
      note: noteText.trim(),
    });
    if (error) {
      toast.error('Failed to save note');
    } else {
      toast.success('Note saved');
      setNoteText('');
      queryClient.invalidateQueries({ queryKey: ['notes', 'candidate', id] });
    }
    setSaving(false);
  };

  const initials = `${candidate.first_name?.[0] ?? ''}${candidate.last_name?.[0] ?? ''}`;
  const fullName = candidate.full_name ?? `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`;

  return (
    <MainLayout>
      {/* Top bar */}
      <div className="flex items-center gap-3 px-8 py-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => navigate('/candidates')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-foreground">{fullName}</h1>
          <p className="text-sm text-muted-foreground">
            {candidate.current_title ?? ''}{candidate.current_title && candidate.current_company ? ' at ' : ''}{candidate.current_company ?? ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="gold" size="sm" onClick={() => setEnrollOpen(true)}>
            <Play className="h-3.5 w-3.5" />
            Enroll in Sequence
          </Button>
          <Button variant="gold-outline" size="sm">
            <Edit className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button variant="ghost" size="icon">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <aside className="w-80 shrink-0 border-r border-border overflow-y-auto">
          <div className="p-6 space-y-6">
            <div className="flex flex-col items-center text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/10 text-lg font-semibold text-accent mb-3">
                {initials}
              </div>
              <Badge variant="secondary" className="capitalize">{candidate.status}</Badge>
            </div>

            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Contact</h3>
              <div className="space-y-2">
                {candidate.email && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                    <a href={`mailto:${candidate.email}`} className="hover:text-accent truncate">{candidate.email}</a>
                  </div>
                )}
                {candidate.phone && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{candidate.phone}</span>
                  </div>
                )}
                {candidate.linkedin_url && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Linkedin className="h-3.5 w-3.5 text-muted-foreground" />
                    <a href={candidate.linkedin_url} target="_blank" rel="noreferrer" className="hover:text-accent truncate">LinkedIn</a>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Current Role</h3>
              <div className="space-y-2">
                {candidate.current_title && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Briefcase className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{candidate.current_title}</span>
                  </div>
                )}
                {candidate.current_company && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Building className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{candidate.current_company}</span>
                  </div>
                )}
                {candidate.location && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{candidate.location}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Details</h3>
              <div className="space-y-2 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Calendar className="h-3.5 w-3.5" />
                  Added {format(new Date(candidate.created_at), 'MMM d, yyyy')}
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <Tabs defaultValue="communications" className="flex-1 flex flex-col overflow-hidden">
            <div className="px-8 pt-4">
              <TabsList className="bg-secondary">
                <TabsTrigger value="communications" className="gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Communications
                </TabsTrigger>
                <TabsTrigger value="activity" className="gap-1.5">
                  <History className="h-3.5 w-3.5" />
                  Activity
                </TabsTrigger>
                <TabsTrigger value="notes" className="gap-1.5">
                  <User className="h-3.5 w-3.5" />
                  Notes
                </TabsTrigger>
              </TabsList>
            </div>

            <ScrollArea className="flex-1">
              <TabsContent value="communications" className="px-8 py-4 mt-0">
                <div className="flex items-center gap-2 mb-6">
                  <Button variant="outline" size="sm"><Mail className="h-3.5 w-3.5" /> Email</Button>
                  <Button variant="outline" size="sm"><Phone className="h-3.5 w-3.5" /> Call</Button>
                  <Button variant="outline" size="sm"><Linkedin className="h-3.5 w-3.5" /> LinkedIn</Button>
                  <Button variant="outline" size="sm"><MessageSquare className="h-3.5 w-3.5" /> SMS</Button>
                </div>
                {conversations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No communications yet.</p>
                ) : (
                  <div className="space-y-4">
                    {conversations.map((conv: any) => (
                      <div key={conv.id} className="rounded-lg border border-border p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium text-foreground capitalize">{conv.channel}</span>
                          <span className="text-xs text-muted-foreground">
                            {conv.last_message_at ? format(new Date(conv.last_message_at), 'MMM d, yyyy') : ''}
                          </span>
                        </div>
                        {conv.subject && <p className="text-sm text-foreground mb-1">{conv.subject}</p>}
                        {conv.last_message_preview && <p className="text-xs text-muted-foreground">{conv.last_message_preview}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="activity" className="px-8 py-4 mt-0">
                <p className="text-sm text-muted-foreground">Activity history will appear here.</p>
              </TabsContent>

              <TabsContent value="notes" className="px-8 py-4 mt-0">
                <div className="space-y-4">
                  <textarea
                    placeholder="Add a note..."
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    className="w-full h-28 rounded-lg border border-input bg-background text-foreground p-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                  />
                  <Button variant="gold" size="sm" onClick={handleSaveNote} disabled={saving || !noteText.trim()}>
                    Save Note
                  </Button>
                  {notes.length > 0 ? (
                    <div className="space-y-3">
                      {notes.map((n: any) => (
                        <div key={n.id} className="rounded-md border border-border bg-secondary/50 p-4">
                          <p className="text-sm text-foreground">{n.note}</p>
                          <p className="text-xs text-muted-foreground mt-2">
                            {format(new Date(n.created_at), 'MMM d, yyyy h:mm a')}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No notes yet.</p>
                  )}
                </div>
              </TabsContent>
            </ScrollArea>
          </Tabs>
        </div>
      </div>

      <EnrollInSequenceDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        candidateIds={id ? [id] : []}
        candidateNames={[fullName]}
      />
    </MainLayout>
  );
};

export default CandidateDetail;
