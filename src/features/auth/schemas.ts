import { z } from "zod";

const password = z.string().min(8, "Mínimo de 8 caracteres").max(72, "Máximo de 72 caracteres");

export const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email("E-mail inválido"),
  password: z.string().min(1, "Informe a senha").max(72),
});

export const signUpSchema = z.object({
  fullName: z.string().trim().min(2, "Informe seu nome").max(120),
  email: z.string().trim().toLowerCase().email("E-mail inválido"),
  password,
});

export const resetRequestSchema = z.object({ email: z.string().trim().toLowerCase().email("E-mail inválido") });

/** Recovery/invite link: only the new password. */
export const newPasswordSchema = z.object({ password });

/** Signed in normally: the current password is required (checked on the server too). */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Informe a senha atual").max(72),
  password,
});

/** Re-entering the password before a sensitive change (e.g. enrolling the first two-step factor). */
export const reauthSchema = z.object({ password: z.string().min(1, "Informe sua senha").max(72) });

/** E-mail link types handled by /auth/confirm (templates in supabase/templates). */
export const CONFIRM_TYPES = ["signup", "invite", "magiclink", "recovery", "email_change", "email"] as const;
export type ConfirmType = (typeof CONFIRM_TYPES)[number];
export const isConfirmType = (value: unknown): value is ConfirmType => CONFIRM_TYPES.includes(value as ConfirmType);

export const confirmSchema = z.object({
  token_hash: z.string().min(1).max(1024),
  type: z.enum(CONFIRM_TYPES),
  next: z.string().max(2048).optional(),
});

export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
