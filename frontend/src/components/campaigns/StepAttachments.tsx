import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Paperclip, X, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Attachment {
  name: string;
  path: string;
  size: number;
  type: string;
}

interface StepAttachmentsProps {
  attachments: Attachment[];
  onAttachmentsChange: (attachments: Attachment[]) => void;
  stepId: string;
}

export const StepAttachments = ({ attachments, onAttachmentsChange, stepId }: StepAttachmentsProps) => {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    const newAttachments: Attachment[] = [];

    for (const file of Array.from(files)) {
      if (file.size > 10 * 1024 * 1024) {
        toast.error(`${file.name} exceeds 10MB limit`);
        continue;
      }

      const filePath = `${stepId}/${Date.now()}-${file.name}`;
      const { error } = await supabase.storage.from('sequence-attachments').upload(filePath, file);
      if (error) {
        toast.error(`Failed to upload ${file.name}`);
        console.error(error);
        continue;
      }

      newAttachments.push({
        name: file.name,
        path: filePath,
        size: file.size,
        type: file.type,
      });
    }

    if (newAttachments.length > 0) {
      onAttachmentsChange([...attachments, ...newAttachments]);
      toast.success(`${newAttachments.length} file${newAttachments.length > 1 ? 's' : ''} uploaded`);
    }

    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleRemove = async (index: number) => {
    const att = attachments[index];
    await supabase.storage.from('sequence-attachments').remove([att.path]);
    onAttachmentsChange(attachments.filter((_, i) => i !== index));
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Paperclip className="h-3.5 w-3.5 mr-1" />}
          Attach File
        </Button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleUpload}
          accept=".pdf,.doc,.docx,.xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.gif"
        />
      </div>

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((att, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs"
            >
              <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate max-w-[120px] text-foreground">{att.name}</span>
              <span className="text-muted-foreground">{formatSize(att.size)}</span>
              <button
                type="button"
                onClick={() => handleRemove(i)}
                className="ml-0.5 text-muted-foreground hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
