const { error } = await supabase
  .from("candidates")
  .insert([
    {
      first_name,
      last_name,
      email,
      phone,
      status: "new"
    }
  ])

if (error) {
  console.error(error)
}
