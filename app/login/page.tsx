import { redirect } from "next/navigation";
import { getAuthenticatedContext } from "@/lib/supabase/auth";
import { AuthForm } from "./auth-form";

export default async function LoginPage() {
  const context = await getAuthenticatedContext();
  if (context) redirect("/");
  return <AuthForm />;
}
