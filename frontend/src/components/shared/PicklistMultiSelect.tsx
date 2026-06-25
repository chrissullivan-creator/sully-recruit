import { usePicklist } from '@/hooks/useData';
import { Badge } from '@/components/ui/badge';

interface PicklistMultiSelectProps {
  /** picklist_options category, e.g. 'department' | 'products' | 'industry' | 'strategy'. */
  category: string;
  /** Currently selected values. */
  value: string[];
  /** Called with the next selection when a badge is toggled. */
  onChange: (v: string[]) => void;
  disabled?: boolean;
}

/**
 * Toggle-badge multi-select backed by the shared picklist_options lists.
 * Presentational only — the parent owns persistence. Renders the admin-defined
 * options for `category` plus any legacy values already in `value` that are no
 * longer in the option list, so historical data still shows.
 */
export function PicklistMultiSelect({ category, value, onChange, disabled }: PicklistMultiSelectProps) {
  const { data: options = [] } = usePicklist(category);

  const selected = Array.isArray(value) ? value : [];
  // Legacy values present on the record but missing from the active option list.
  const extras = selected.filter((v) => !options.includes(v));
  const allOptions = [...options, ...extras];

  const toggle = (opt: string) =>
    onChange(selected.includes(opt) ? selected.filter((o) => o !== opt) : [...selected, opt]);

  if (allOptions.length === 0) {
    return <p className="text-xs text-muted-foreground">No options defined.</p>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {allOptions.map((opt) => (
        <button type="button" key={opt} onClick={() => !disabled && toggle(opt)} disabled={disabled}>
          <Badge
            variant={selected.includes(opt) ? 'default' : 'outline'}
            className={disabled ? 'opacity-60' : 'cursor-pointer'}
          >
            {opt}
          </Badge>
        </button>
      ))}
    </div>
  );
}
