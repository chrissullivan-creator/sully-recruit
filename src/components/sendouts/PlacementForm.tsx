import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { addDays, format, parseISO } from 'date-fns';
import { Loader2, Save } from 'lucide-react';

interface PlacementFormProps {
  sendOutId: string;
}

interface PlacementRow {
  id: string;
  send_out_id: string;
  salary: number | null;
  fee_type: 'percent' | 'flat' | string | null;
  fee_pct: number | null;
  fee_amount: number | null;
  invoice_status: 'pending' | 'sent' | 'paid' | 'overdue' | string | null;
  invoice_date: string | null;
  invoice_number: string | null;
  payment_date: string | null;
  guarantee_days: number | null;
  guarantee_end_date: string | null;
  falloff: boolean;
  notes: string | null;
}

function usePlacement(sendOutId: string) {
  return useQuery({
    queryKey: ['placement', sendOutId],
    enabled: !!sendOutId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('placements')
        .select('*')
        .eq('send_out_id', sendOutId)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as PlacementRow | null) ?? null;
    },
  });
}

export function PlacementForm({ sendOutId }: PlacementFormProps) {
  const { data: placement, isLoading } = usePlacement(sendOutId);
  const qc = useQueryClient();

  const [salary, setSalary] = useState<string>('');
  const [feeType, setFeeType] = useState<string>('percent');
  const [feePercent, setFeePercent] = useState<string>('');
  const [feeAmount, setFeeAmount] = useState<string>('');
  const [invoiceStatus, setInvoiceStatus] = useState<string>('pending');
  const [invoiceDate, setInvoiceDate] = useState<string>('');
  const [invoiceNumber, setInvoiceNumber] = useState<string>('');
  const [paymentDate, setPaymentDate] = useState<string>('');
  const [guaranteeDays, setGuaranteeDays] = useState<string>('90');
  const [falloff, setFalloff] = useState<boolean>(false);
  const [notes, setNotes] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!placement) return;
    setSalary(placement.salary != null ? String(placement.salary) : '');
    setFeeType(placement.fee_type ?? 'percent');
    setFeePercent(placement.fee_pct != null ? String(placement.fee_pct) : '');
    setFeeAmount(placement.fee_amount != null ? String(placement.fee_amount) : '');
    setInvoiceStatus(placement.invoice_status ?? 'pending');
    setInvoiceDate(placement.invoice_date ?? '');
    setInvoiceNumber(placement.invoice_number ?? '');
    setPaymentDate(placement.payment_date ?? '');
    setGuaranteeDays(placement.guarantee_days != null ? String(placement.guarantee_days) : '90');
    setFalloff(!!placement.falloff);
    setNotes(placement.notes ?? '');
  }, [placement]);

  // Auto-calc fee amount from percent × salary (unless flat fee is chosen).
  useEffect(() => {
    if (feeType !== 'percent') return;
    const s = parseFloat(salary);
    const p = parseFloat(feePercent);
    if (!isNaN(s) && !isNaN(p)) {
      const amount = Math.round(s * (p / 100));
      setFeeAmount(String(amount));
    }
  }, [salary, feePercent, feeType]);

  // Auto-calc guarantee end date from invoice/payment date + guarantee days.
  const guaranteeEndDate = useMemo(() => {
    const base = paymentDate || invoiceDate;
    const days = parseInt(guaranteeDays, 10);
    if (!base || isNaN(days)) return '';
    try {
      return format(addDays(parseISO(base), days), 'yyyy-MM-dd');
    } catch {
      return '';
    }
  }, [paymentDate, invoiceDate, guaranteeDays]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        send_out_id: sendOutId,
        salary: salary ? parseFloat(salary) : null,
        fee_type: feeType,
        fee_pct: feePercent ? parseFloat(feePercent) : null,
        fee_amount: feeAmount ? parseFloat(feeAmount) : null,
        invoice_status: invoiceStatus,
        invoice_date: invoiceDate || null,
        invoice_number: invoiceNumber || null,
        payment_date: paymentDate || null,
        guarantee_days: guaranteeDays ? parseInt(guaranteeDays, 10) : null,
        guarantee_end_date: guaranteeEndDate || null,
        falloff,
        notes: notes || null,
      };

      if (placement?.id) {
        const { error } = await supabase
          .from('placements')
          .update(payload)
          .eq('id', placement.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('placements').insert(payload);
        if (error) throw error;
      }
      qc.invalidateQueries({ queryKey: ['placement', sendOutId] });
      toast.success('Placement saved');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save placement');
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 inline animate-spin mr-1" /> Loading placement…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Salary (USD)</Label>
          <Input
            type="number"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
            placeholder="150000"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Fee type</Label>
          <Select value={feeType} onValueChange={setFeeType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="percent">% of salary</SelectItem>
              <SelectItem value="flat">Flat fee</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Fee %</Label>
          <Input
            type="number"
            step="0.1"
            value={feePercent}
            onChange={(e) => setFeePercent(e.target.value)}
            placeholder="20"
            disabled={feeType !== 'percent'}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Fee amount (USD)</Label>
          <Input
            type="number"
            value={feeAmount}
            onChange={(e) => setFeeAmount(e.target.value)}
            placeholder="30000"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Invoice status</Label>
          <Select value={invoiceStatus} onValueChange={setInvoiceStatus}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Invoice number</Label>
          <Input
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            placeholder="INV-001"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Invoice date</Label>
          <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Payment date</Label>
          <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Guarantee days</Label>
          <Input
            type="number"
            value={guaranteeDays}
            onChange={(e) => setGuaranteeDays(e.target.value)}
            placeholder="90"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Guarantee end date</Label>
          <div className="flex h-9 items-center rounded-md border border-border bg-muted/30 px-3 text-xs text-muted-foreground">
            {guaranteeEndDate || '—'}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
        <div>
          <Label className="text-xs">Fall-off</Label>
          <div className="text-[11px] text-muted-foreground">
            Mark the placement as reversed if the candidate leaves within the guarantee window.
          </div>
        </div>
        <div className="flex items-center gap-2">
          {falloff && <Badge variant="outline" className="text-[10px] bg-red-100 text-red-700 border-red-200">Falloff</Badge>}
          <Switch checked={falloff} onCheckedChange={setFalloff} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Notes</Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={save}
          disabled={saving}
          className="bg-emerald-700 hover:bg-emerald-800 text-white"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
          Save Placement
        </Button>
      </div>
    </div>
  );
}

export default PlacementForm;
