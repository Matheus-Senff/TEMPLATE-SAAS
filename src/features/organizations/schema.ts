import { z } from "zod";

export const createOrganizationSchema = z.object({ name: z.string().trim().min(1, "Informe o nome").max(120) });

export const inviteMemberSchema = z.object({
  orgId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email("E-mail inválido").max(254),
  role: z.enum(["admin", "member"]).default("member"),
});

export const acceptInvitationSchema = z.object({ token: z.string().min(20).max(200) });
