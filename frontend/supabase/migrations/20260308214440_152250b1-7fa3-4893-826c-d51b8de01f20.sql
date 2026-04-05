
-- Create storage bucket for sequence step attachments
INSERT INTO storage.buckets (id, name, public)
VALUES ('sequence-attachments', 'sequence-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- RLS policies for sequence-attachments bucket
CREATE POLICY "Authenticated users can upload sequence attachments"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'sequence-attachments');

CREATE POLICY "Authenticated users can read sequence attachments"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'sequence-attachments');

CREATE POLICY "Authenticated users can delete sequence attachments"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'sequence-attachments');
