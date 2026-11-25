import { createClient } from "@/lib/supabase/server";

export async function getAuthenticatedContext() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims.sub;

  if (error || !userId) return null;

  return {
    supabase,
    userId,
    email: typeof data.claims.email === "string" ? data.claims.email : "",
  };
}
