const { count } = await supabase
  .from("candidates")
  .select("*", { count: "exact", head: true })
  .eq("status", "engaged")
