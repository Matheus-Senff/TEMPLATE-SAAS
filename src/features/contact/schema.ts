import { z } from "zod";

/** Validated in the browser (form) and on the server (action). */
export const contactSchema = z.object({
  name: z.string().trim().min(2, "Informe seu nome").max(120),
  email: z.string().trim().toLowerCase().email("E-mail inválido").max(254),
  phone: z
    .string()
    .trim()
    .max(20)
    .regex(/^[\d\s()+-]*$/, "Telefone inválido")
    .optional(),
  message: z.string().trim().min(10, "Escreva pelo menos 10 caracteres").max(5000),
  /** Honeypot: hidden field that only bots fill (accepted and silently dropped). */
  website: z.string().max(200).optional(),
});

export type ContactInput = z.infer<typeof contactSchema>;
