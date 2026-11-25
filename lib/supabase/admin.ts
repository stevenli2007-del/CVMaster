import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Server-only destructive operations use this client after the caller's session
// and object ownership have been verified through the regular user client.
// The secret must never use a NEXT_PUBLIC_ prefix or enter a client module.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;

  return createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
