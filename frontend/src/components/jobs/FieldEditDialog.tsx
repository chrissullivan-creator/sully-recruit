import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { Loader2 } from 'lucide-react';

interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  fieldType: 'text' | 'richtext' | 'select';
  value: string;
  onSave: (value: string) => Promise<void>;
  selectOptions?: SelectOption[];
  placeholder?: string;
}

export function FieldEditDialog({
  open, onOpenChange, title, fieldType, value, onSave, selectOptions, placeholder,
}: Props) {
  const [localValue, setLocalValue] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setLocalValue(value);
  }, [open, value]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(localValue);
      onOpenChange(false);
    } catch {
      // error handling done by caller
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={fieldType === 'richtext' ? 'max-w-2xl max-h-[85vh] overflow-y-auto' : 'max-w-md'}>
        <DialogHeader>
          <DialogTitle>Edit {title}</DialogTitle>
        </DialogHeader>

        <div className="py-2">
          {fieldType === 'text' && (
            <Input
              value={localValue}
              onChange={e => setLocalValue(e.target.value)}
              placeholder={placeholder}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
            />
          )}

          {fieldType === 'select' && selectOptions && (
            <Select value={localValue} onValueChange={setLocalValue}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {selectOptions.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {fieldType === 'richtext' && (
            <RichTextEditor
              value={localValue}
              onChange={setLocalValue}
              placeholder={placeholder || 'Start typing...'}
              minHeight="200px"
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="gold" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
