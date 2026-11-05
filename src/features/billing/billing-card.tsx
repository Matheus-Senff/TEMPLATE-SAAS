"use client";

import { useTransition } from "react";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/misc";
import type { ActionResult } from "@/lib/action";
import { openBillingPortal, startCheckout } from "./actions";

const PRICE_ID = process.env.NEXT_PUBLIC_STRIPE_PRICE_ID;
const TERMINAL = ["canceled", "incomplete_expired"];
const statusLabel: Record<string, string> = {
  active: "Ativa",
  trialing: "Em teste",
  past_due: "Pagamento pendente",
  unpaid: "Não paga",
  incomplete: "Incompleta",
  incomplete_expired: "Expirada",
  paused: "Pausada",
  canceled: "Cancelada",
};

type Props = {
  status: string | null;
  enabled: boolean;
  /** A Stripe customer exists: only then the Customer Portal has something to manage. */
  hasCustomer: boolean;
  /** Back from Checkout but the payment is not confirmed yet (boleto/Pix or webhook still on the way). */
  processing?: boolean;
  /** Owner/admin of the organization (billing is per organization). */
  canManage?: boolean;
};

/** Checkout / Customer Portal through Server Actions. Subscription status comes from Stripe (webhook + return sync). */
export function BillingCard({ status, enabled, hasCustomer, processing = false, canManage = true }: Props) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const canSubscribe = canManage && !processing && (!status || TERMINAL.includes(status));
  const run = (action: () => Promise<ActionResult>) =>
    startTransition(async () => {
      try {
        // On success the action redirects (Stripe page); only failures come back here.
        const result = await action();
        if (!result.ok) toast({ type: "error", title: result.error });
      } catch {
        toast({ type: "error", title: "Sem conexão com o servidor", body: "Confira sua internet e tente de novo." });
      }
    });

  return (
    <Card title="Assinatura">
      {!enabled ? (
        <p className="text-sm text-neutral-500">Defina STRIPE_SECRET_KEY e NEXT_PUBLIC_STRIPE_PRICE_ID para ativar.</p>
      ) : (
        <>
          <p className="text-sm">
            Status:{" "}
            {processing ? (
              <Badge tone="warning">Processando pagamento</Badge>
            ) : status ? (
              <Badge tone={status === "active" ? "success" : "warning"}>{statusLabel[status] ?? status}</Badge>
            ) : (
              "Sem assinatura"
            )}
          </p>
          {processing && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Recebemos seu pedido. Boleto e Pix podem levar alguns minutos (ou até 3 dias úteis no boleto); avisamos no
              sininho quando o pagamento for confirmado.
            </p>
          )}
          <div className="flex gap-2">
            {canSubscribe && PRICE_ID && (
              <Button
                size="sm"
                loading={pending}
                onClick={() => run(() => startCheckout({ priceId: PRICE_ID, mode: "subscription" }))}
              >
                Assinar
              </Button>
            )}
            {canManage && hasCustomer && (
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(openBillingPortal)}>
                Gerenciar assinatura
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
