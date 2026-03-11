import { useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Upload, FileSpreadsheet, Loader2, AlertCircle } from 'lucide-react';

type EntityType = 'candidates' | 'contacts' | 'jobs';

interface FieldMapping {
  csvHeader: string;
  dbColumn: string;
}

const entityFields: Record<EntityType, { value: string; label: string }[]> = {
  candidates: [
    { value: 'skip', label: '— Skip —' },
    { value: 'first_name', label: 'First Name' },
    { value: 'last_name', label: 'Last Name' },
    { value: 'email', label: 'Email' },
    { value: 'phone', label: 'Phone' },
    { value: 'linkedin_url', label: 'LinkedIn URL' },
    { value: 'current_company', label: 'Company' },
    { value: 'current_title', label: 'Title' },
    { value: 'status', label: 'Status' },
    { value: 'source', label: 'Source' },
  ],
  contacts: [
    { value: 'skip', label: '— Skip —' },
    { value: 'first_name', label: 'First Name' },
    { value: 'last_name', label: 'Last Name' },
    { value: 'email', label: 'Email' },
    { value: 'phone', label: 'Phone' },
    { value: 'linkedin_url', label: 'LinkedIn URL' },
    { value: 'title', label: 'Title' },
    { value: 'department', label: 'Department' },
    { value: 'status', label: 'Status' },
  ],
  jobs: [
    { value: 'skip', label: '— Skip —' },
    { value: 'title', label: 'Title' },
    { value: 'company', label: 'Company' },
    { value: 'location', label: 'Location' },
    { value: 'salary', label: 'Salary' },
    { value: 'status', label: 'Status' },
    { value: 'hiring_manager', label: 'Hiring Manager' },
  ],
};

function autoMapHeader(header: string, entity: EntityType): string {
  const h = header.toLowerCase().replace(/[^a-z]/g, '');
  const mappings: Record<string, string> = {
    firstname: 'first_name', first: 'first_name', fname: 'first_name',
    lastname: 'last_name', last: 'last_name', lname: 'last_name',
    email: 'email', emailaddress: 'email',
    phone: 'phone', phonenumber: 'phone', mobile: 'phone',
    linkedin: 'linkedin_url', linkedinurl: 'linkedin_url',
    company: entity === 'jobs' ? 'company' : (entity === 'contacts' ? 'company_name' : 'current_company'),
    companyname: entity === 'jobs' ? 'company' : (entity === 'contacts' ? 'company_name' : 'current_company'),
    currentcompany: 'current_company',
    title: 'title',
    jobtitle: 'title',
    currenttitle: 'current_title',
    status: 'status',
    stage: entity === 'jobs' ? 'stage' : 'skip',
    location: 'location',
    salary: 'salary',
    hiringmanager: 'hiring_manager',
    department: 'department', dept: 'department',
    source: 'source',
    notes: 'notes',
  };
  const match = mappings[h];
  if (match && entityFields[entity].some(f => f.value === match)) return match;
  return 'skip';
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  
  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: EntityType;
}

export function CsvImportDialog({ open, onOpenChange, entityType }: Props) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<'upload' | 'map' | 'importing'>('upload');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mappings, setMappings] = useState<FieldMapping[]>([]);
  const [importResult, setImportResult] = useState<{ success: number; errors: number } | null>(null);

  const reset = () => {
    setStep('upload');
    setHeaders([]);
    setRows([]);
    setMappings([]);
    setImportResult(null);
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { headers: h, rows: r } = parseCsv(text);
      if (h.length === 0) { toast.error('Empty or invalid CSV'); return; }
      setHeaders(h);
      setRows(r);
      setMappings(h.map(header => ({ csvHeader: header, dbColumn: autoMapHeader(header, entityType) })));
      setStep('map');
    };
    reader.readAsText(file);
  };

  const updateMapping = (index: number, dbColumn: string) => {
    setMappings(prev => prev.map((m, i) => i === index ? { ...m, dbColumn } : m));
  };

  const handleImport = async () => {
    const activeMappings = mappings.filter(m => m.dbColumn !== 'skip');
    if (activeMappings.length === 0) { toast.error('Map at least one column'); return; }

    const ownerTables: EntityType[] = ['candidates', 'contacts'];
    const needsOwner = ownerTables.includes(entityType);
    const userId = needsOwner ? (await supabase.auth.getUser()).data.user?.id : undefined;

    setStep('importing');
    let success = 0;
    let errors = 0;

    const batchSize = 50;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const records = batch.map(row => {
        const record: Record<string, string | undefined> = {};
        mappings.forEach((m, idx) => {
          if (m.dbColumn !== 'skip' && row[idx] !== undefined) {
            record[m.dbColumn] = row[idx];
          }
        });
        if (needsOwner && userId) {
          record['owner_id'] = userId;
        }
        return record;
      }).filter(r => Object.keys(r).length > (needsOwner ? 1 : 0));

      if (records.length === 0) continue;

      const { error } = await supabase.from(entityType).insert(records as any);
      if (error) {
        console.error('Import batch error:', error);
        toast.error(`Batch error: ${error.message || 'Unknown error'}`);
        errors += records.length;
      } else {
        success += records.length;
      }
    }

    setImportResult({ success, errors });
    if (success > 0) {
      queryClient.invalidateQueries({ queryKey: [entityType] });
      toast.success(`Imported ${success} ${entityType}`);
    }
    if (errors > 0) toast.error(`${errors} rows failed to import`);
  };

  const entityLabel = entityType.charAt(0).toUpperCase() + entityType.slice(1);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Import {entityLabel} from CSV
          </DialogTitle>
        </DialogHeader>

        {step === 'upload' && (
          <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-border rounded-lg">
            <Upload className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground mb-4">Select a CSV file to import {entityType}</p>
            <Button variant="gold" onClick={() => fileRef.current?.click()}>
              Choose File
            </Button>
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
          </div>
        )}

        {step === 'map' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertCircle className="h-4 w-4" />
              <span>{rows.length} rows found. Map CSV columns to {entityLabel} fields:</span>
            </div>
            <ScrollArea className="max-h-[400px]">
              <div className="space-y-3">
                {headers.map((header, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-1/3">
                      <p className="text-sm font-medium text-foreground truncate">{header}</p>
                      <p className="text-xs text-muted-foreground truncate">{rows[0]?.[i] ?? ''}</p>
                    </div>
                    <span className="text-muted-foreground">→</span>
                    <div className="flex-1">
                      <Select value={mappings[i]?.dbColumn ?? 'skip'} onValueChange={(v) => updateMapping(i, v)}>
                        <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {entityFields[entityType].map(f => (
                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        {step === 'importing' && !importResult && (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-gold mb-3" />
            <p className="text-sm text-muted-foreground">Importing {rows.length} {entityType}...</p>
          </div>
        )}

        {importResult && (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-lg font-semibold text-foreground mb-2">Import Complete</p>
            <p className="text-sm text-success">{importResult.success} successfully imported</p>
            {importResult.errors > 0 && <p className="text-sm text-destructive">{importResult.errors} failed</p>}
          </div>
        )}

        <DialogFooter>
          {step === 'map' && (
            <Button variant="gold" onClick={handleImport}>
              Import {rows.length} {entityLabel}
            </Button>
          )}
          {importResult && (
            <Button variant="gold" onClick={() => { reset(); onOpenChange(false); }}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
