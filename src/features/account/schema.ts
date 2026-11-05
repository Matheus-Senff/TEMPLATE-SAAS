import { z } from "zod";

/** Account deletion asks for the current password again (re-authentication). */
export const deleteAccountSchema = z.object({ password: z.string().min(1, "Informe sua senha").max(72) });

export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
