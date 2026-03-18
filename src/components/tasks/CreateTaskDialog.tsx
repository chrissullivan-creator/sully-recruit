import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { useCreateTask } from '@/hooks/useTasks';
import { useProfiles } from '@/hooks/useProfiles';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, CalendarIcon, Search, X, User, Briefcase, Building } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultLinks?: { entity_type: string; entity_id: string }[];
}

type EntityType = 'candidate' | 'job' | 'contact';

const ENTITY_CONFIG: Record<EntityType, { label: string; plural: string; icon: React.ElementType; emoji: string }> = {
  candidate: { label: 'Candidate', plural: 'candidates', icon: User, emoji: '👤' },
  job: { label: 'Job', plural: 'jobs', icon: Briefcase, emoji: '💼' },
  contact: { label: 'Contact', plural: 'contacts', icon: Building, emoji: '🤝' },
};

export function CreateTaskDialog({ open, onOpenChange, defaultLinks }: Props) {
  const { user } = useAuth();
  const createTask = useCreateTask();
  const { data: profiles = [] } = useProfiles();
  const [form, setForm] = useState({
    title: '',
    description: '',
    due_date: new Date(),
    assigned_to: '',
  });
  const [links, setLinks] = useState<{ entity_type: string; entity_id: string; label: string }[]>([]);
  const [entitySearch, setEntitySearch] = useState('');
  const [entityType, setEntityType] = useState<EntityType>('candidate');
  const [searchResults, setSearchResults] = useState<{ id: string; label: string }[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({ title: '', description: '', due_date: new Date(), assigned_to: '' });
      setLinks(defaultLinks?.map(l => ({ ...l, label: '' })) || []);
      setEntitySearch('');
      setSearchResults([]);
    }
  }, [open, defaultLinks]);

  // Search entities with debounce
  useEffect(() => {
    if (!entitySearch.trim()) { setSearchResults([]); return; }
    const timeout = setTimeout(async () => {
      setSearching(true);
      if (entityType === 'candidate') {
        const { data } = await supabase.from('candidates').select('id, full_name').ilike('full_name', `%${entitySearch}%`).limit(8);
        setSearchResults((data || []).map(c => ({ id: c.id, label: c.full_name || 'Unnamed' })));
      } else if (entityType === 'job') {
        // Only show non-closed jobs
        const { data } = await supabase.from('jobs').select('id, title, company_name, status').ilike('title', `%${entitySearch}%`).neq('status', 'closed').limit(8);
        setSearchResults((data || []).map(j => ({ id: j.id, label: `${j.title}${j.company_name ? ` — ${j.company_name}` : ''}` })));
      } else if (entityType === 'contact') {
        const { data } = await supabase.from('contacts').select('id, full_name, title, email').ilike('full_name', `%${entitySearch}%`).limit(8);
        setSearchResults((data || []).map(c => ({ id: c.id, label: `${c.full_name || 'Unnamed'}${c.title ? ` · ${c.title}` : ''}` })));
      }
      setSearching(false);
    }, 300);
    return () => clearTimeout(timeout);
  }, [entitySearch, entityType]);

  const addLink = (id: string, label: string) => {
    if (!links.find(l => l.entity_id === id)) {
      setLinks(prev => [...prev, { entity_type: entityType, entity_id: id, label }]);
    }
    setEntitySearch('');
    setSearchResults([]);
  };

  const removeLink = (id: string) => setLinks(prev => prev.filter(l => l.entity_id !== id));

  const handleCreate = () => {
    if (!form.title.trim()) return;
    createTask.mutate(
      {
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        due_date: format(form.due_date, 'yyyy-MM-dd'),
        assigned_to: form.assigned_to || undefined,
        links: links.map(l => ({ entity_type: l.entity_type, entity_id: l.entity_id })),
      },
      {
        onSuccess: () => onOpenChange(false),
      }
    );
  };

  // Group linked items by type
  const candidateLinks = links.filter(l => l.entity_type === 'candidate');
  const jobLinks = links.filter(l => l.entity_type === 'job');
  const contactLinks = links.filter(l => l.entity_type === 'contact');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Title *</Label>
            <Input value={form.title} onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Pitch candidate for Senior Dev role" />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} rows={3} placeholder="Add details, instructions, notes..." />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Due Date *</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal")}>
                    <CalendarIcon className="h-4 w-4 mr-2" />
                    {format(form.due_date, 'MMM d, yyyy')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={form.due_date}
                    onSelect={(d) => d && setForm(f => ({ ...f, due_date: d }))}
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <Label>Assign To</Label>
              <Select value={form.assigned_to} onValueChange={(v) => setForm(f => ({ ...f, assigned_to: v }))}>
                <SelectTrigger><SelectValue placeholder="Select user" /></SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.full_name || p.email || 'Unknown'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Tagged fields - shown per entity type */}
          {candidateLinks.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground flex items-center gap-1">
                <User className="h-3 w-3" /> Candidates
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {candidateLinks.map(l => (
                  <span key={l.entity_id} className="inline-flex items-center gap-1 bg-accent/10 text-accent text-xs px-2.5 py-1 rounded-full border border-accent/20">
                    👤 {l.label || 'Candidate'}
                    <button onClick={() => removeLink(l.entity_id)} className="hover:text-destructive ml-0.5"><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {jobLinks.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground flex items-center gap-1">
                <Briefcase className="h-3 w-3" /> Jobs
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {jobLinks.map(l => (
                  <span key={l.entity_id} className="inline-flex items-center gap-1 bg-info/10 text-info text-xs px-2.5 py-1 rounded-full border border-info/20">
                    💼 {l.label || 'Job'}
                    <button onClick={() => removeLink(l.entity_id)} className="hover:text-destructive ml-0.5"><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {contactLinks.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground flex items-center gap-1">
                <Building className="h-3 w-3" /> Contacts
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {contactLinks.map(l => (
                  <span key={l.entity_id} className="inline-flex items-center gap-1 bg-warning/10 text-warning text-xs px-2.5 py-1 rounded-full border border-warning/20">
                    🤝 {l.label || 'Contact'}
                    <button onClick={() => removeLink(l.entity_id)} className="hover:text-destructive ml-0.5"><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Tag search */}
          <div className="space-y-2">
            <Label>Tag Candidates, Jobs & Contacts</Label>
            <div className="flex gap-2">
              <Select value={entityType} onValueChange={(v) => { setEntityType(v as EntityType); setEntitySearch(''); setSearchResults([]); }}>
                <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="candidate">Candidate</SelectItem>
                  <SelectItem value="job">Job</SelectItem>
                  <SelectItem value="contact">Contact</SelectItem>
                </SelectContent>
              </Select>
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={entitySearch}
                  onChange={(e) => setEntitySearch(e.target.value)}
                  placeholder={`Search ${ENTITY_CONFIG[entityType].plural}...`}
                  className="pl-7 h-9 text-sm"
                />
                {searching && (
                  <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
                {searchResults.length > 0 && (
                  <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-lg max-h-40 overflow-y-auto">
                    {searchResults.map(r => {
                      const cfg = ENTITY_CONFIG[entityType];
                      return (
                        <button key={r.id} onClick={() => addLink(r.id, r.label)} className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10 text-foreground flex items-center gap-2">
                          <cfg.icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          {r.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="gold" onClick={handleCreate} disabled={!form.title.trim() || createTask.isPending}>
            {createTask.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Create Task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
