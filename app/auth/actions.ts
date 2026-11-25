"use server";

import { redirect } from "next/navigation";
import { getAuthenticatedContext } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { getSiteUrl } from "@/lib/site-url";
import {
  displayNameSchema,
  emailSchema,
  formString,
  passwordSchema,
} from "@/lib/validation";

export type AuthFormState = {
  status: "idle" | "error" | "success";
  message: string;
};

export async function signIn(
  _previousState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = emailSchema.safeParse(formString(formData, "email"));
  const password = passwordSchema.safeParse(formString(formData, "password"));
  if (!email.success || !password.success) {
    return { status: "error", message: "Enter a valid email and a password of 8–72 characters." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: email.data,
    password: password.data,
  });
  if (error) return { status: "error", message: "Email or password is incorrect." };
  redirect("/");
}

export async function signUp(
  _previousState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = emailSchema.safeParse(formString(formData, "email"));
  const password = passwordSchema.safeParse(formString(formData, "password"));
  const displayName = displayNameSchema.safeParse(formString(formData, "displayName"));
  if (!email.success || !password.success || !displayName.success) {
    return { status: "error", message: "Check your name, email, and password (8–72 characters)." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: email.data,
    password: password.data,
    options: {
      data: { display_name: displayName.data },
      emailRedirectTo: `${getSiteUrl()}/auth/confirm?next=/`,
    },
  });
  if (error) {
    return { status: "error", message: "Could not create the account. Try again or use another email." };
  }
  if (data.session) redirect("/");
  return {
    status: "success",
    message: "Check your inbox to confirm your email, then sign in.",
  };
}

export async function requestPasswordReset(
  _previousState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = emailSchema.safeParse(formString(formData, "email"));
  if (!email.success) return { status: "error", message: "Enter a valid email address." };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email.data, {
    redirectTo: `${getSiteUrl()}/auth/confirm?next=/reset-password`,
  });
  if (error) {
    return { status: "error", message: "Could not request a reset link. Please try again." };
  }
  return {
    status: "success",
    message: "If an account uses that email, a reset link is on its way.",
  };
}

export async function updatePassword(
  _previousState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const password = passwordSchema.safeParse(formString(formData, "password"));
  if (!password.success) {
    return { status: "error", message: "Use a password of 8–72 characters." };
  }
  const context = await getAuthenticatedContext();
  if (!context) return { status: "error", message: "This reset link has expired. Request a new one." };

  const { error } = await context.supabase.auth.updateUser({ password: password.data });
  if (error) return { status: "error", message: "Could not update the password. Request a new link." };
  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
