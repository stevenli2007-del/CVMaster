import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

function safeNextPath(value: string | null) {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const redirectTo = request.nextUrl.clone();
  redirectTo.pathname = safeNextPath(searchParams.get("next"));
  redirectTo.search = "";

  const supabase = await createClient();
  let verified = false;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    verified = !error;
  } else if (tokenHash && (type === "signup" || type === "recovery")) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    verified = !error;
  }

  if (verified) return NextResponse.redirect(redirectTo);
  redirectTo.pathname = "/auth/error";
  redirectTo.search = "";
  return NextResponse.redirect(redirectTo);
}
