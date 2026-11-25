import { z } from "zod";

export const uuidSchema = z.string().uuid();
export const displayNameSchema = z.string().trim().max(80);
export const experienceNameSchema = z.string().trim().min(1).max(80);
export const noteSchema = z.string().trim().min(1).max(20000);
export const emailSchema = z.string().trim().email().max(320);
export const passwordSchema = z.string().min(8).max(72);
export const linkSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  });

export function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}
