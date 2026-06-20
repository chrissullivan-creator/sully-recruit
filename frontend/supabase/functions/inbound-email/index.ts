import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {

  const body = await req.json();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const toEmail = body.to;
  const fromEmail = body.from;
  const fromName = body.from_name;
  const subject = body.subject;
  const text = body.body;
  const providerMessageId = body.message_id;

  const { data, error } = await supabase.rpc(
    "process_inbound_email",
    {
      p_to_email: toEmail,
      p_from_email: fromEmail,
      p_from_name: fromName,
      p_subject: subject,
      p_body: text,
      p_provider_message_id: providerMessageId
    }
  );

  if (error) {
    return new Response(JSON.stringify({ error }), { status: 500 });
  }

  return new Response(JSON.stringify({ message_id: data }), { status: 200 });

});