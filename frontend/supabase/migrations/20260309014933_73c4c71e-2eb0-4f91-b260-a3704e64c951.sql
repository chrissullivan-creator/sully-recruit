-- Add owner_id to conversations table
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS owner_id uuid;

-- Add owner_id to messages table  
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS owner_id uuid;

-- Add compensation to jobs table
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS compensation text;

-- Drop existing permissive policies on conversations
DROP POLICY IF EXISTS "Authenticated full access conversations" ON public.conversations;

-- Create new RLS policies for conversations - users can only see their own
CREATE POLICY "Users manage own conversations"
ON public.conversations FOR ALL
TO authenticated
USING (owner_id = auth.uid())
WITH CHECK (owner_id = auth.uid());

-- Drop existing permissive policies on messages
DROP POLICY IF EXISTS "Authenticated full access messages" ON public.messages;

-- Create new RLS policies for messages - users can only see messages in their conversations
CREATE POLICY "Users manage own messages"
ON public.messages FOR ALL
TO authenticated
USING (owner_id = auth.uid())
WITH CHECK (owner_id = auth.uid());

-- Create trigger to auto-set owner_id on conversations
CREATE OR REPLACE FUNCTION public.set_conversation_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
begin
  if new.owner_id is null then
    new.owner_id = auth.uid();
  end if;
  return new;
end;
$function$;

DROP TRIGGER IF EXISTS set_conversation_owner_trigger ON public.conversations;
CREATE TRIGGER set_conversation_owner_trigger
  BEFORE INSERT ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_conversation_owner();

-- Create trigger to auto-set owner_id on messages
DROP TRIGGER IF EXISTS set_message_owner_trigger ON public.messages;
CREATE TRIGGER set_message_owner_trigger
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.set_conversation_owner();