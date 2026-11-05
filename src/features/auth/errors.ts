import "server-only";
import { reportError } from "@/lib/log";

export type AuthFlow = "signin" | "signup" | "reset" | "password" | "reauth" | "confirm";

type AuthErrorLike = { code?: string; status?: number; message?: string };

const fallback: Record<AuthFlow, string> = {
  signin: "E-mail ou senha incorretos.",
  signup: "Não foi possível criar a conta. Tente novamente.",
  reset: "Não foi possível enviar o e-mail agora. Tente novamente.",
  password: "Não foi possível alterar a senha. Tente novamente.",
  reauth: "Senha atual incorreta.",
  confirm: "Link inválido ou expirado. Peça um novo e-mail.",
};

/** Expected outcomes (wrong password, limits): logged, but not sent to Sentry as errors. */
const EXPECTED = new Set([
  "invalid_credentials",
  "email_not_confirmed",
  "weak_password",
  "same_password",
  "over_request_rate_limit",
  "over_email_send_rate_limit",
  "otp_expired",
  "user_already_exists",
  "email_exists",
]);

/** SMTP failures: the default Supabase SMTP only delivers to team members (`email_address_not_authorized`). */
const isEmailDeliveryError = (error: AuthErrorLike) =>
  error.code === "email_address_not_authorized" ||
  (Boolean(error.status && error.status >= 500) && /sending .*e-?mail|smtp/i.test(error.message ?? ""));

/**
 * Maps a Supabase Auth error to a pt-BR message and logs its code/status (never the e-mail). Messages never
 * reveal whether an e-mail is registered: sign-in failures are always "e-mail ou senha incorretos".
 */
export function authErrorMessage(flow: AuthFlow, error: AuthErrorLike): string {
  const context = { flow, code: error.code ?? null, status: error.status ?? null };
  if (error.code && EXPECTED.has(error.code)) console.warn("[auth] expected error", context);
  else reportError("auth", new Error(`Auth ${flow} failed: ${error.code ?? error.status ?? "unknown"}`), context);

  switch (error.code) {
    case "captcha_failed":
      return "Não conseguimos confirmar que você não é um robô. Marque a verificação de novo.";
    case "over_request_rate_limit":
      return "Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.";
    case "over_email_send_rate_limit":
      return "Muitos e-mails enviados agora. Aguarde alguns minutos antes de pedir outro.";
    case "email_not_confirmed":
      return flow === "signin" ? "Confirme seu e-mail antes de entrar (veja sua caixa de entrada)." : fallback[flow];
    case "weak_password":
      return "Senha muito fraca. Use pelo menos 8 caracteres, misturando letras e números.";
    case "same_password":
      return "A nova senha precisa ser diferente da atual.";
    case "insufficient_aal":
      return "Confirme o código do seu app autenticador (Segurança) e tente de novo.";
    case "signup_disabled":
      return "Cadastros estão desativados no momento.";
    case "email_address_invalid":
      return "E-mail inválido.";
    case "otp_expired":
      return fallback.confirm;
  }
  if (isEmailDeliveryError(error)) return "Não conseguimos enviar o e-mail agora. Tente novamente em alguns minutos.";
  return fallback[flow];
}
