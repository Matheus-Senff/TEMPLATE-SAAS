"use client";

import { useEffect } from "react";
import { captureClientError } from "@/lib/sentry-client";
import { Button } from "@/components/ui/button";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    captureClientError(error);
  }, [error]);

  return (
    <section className="space-y-3">
      <h1 className="text-2xl font-bold">Algo deu errado.</h1>
      <p className="text-neutral-600 dark:text-neutral-400">O erro foi registrado. Tente novamente.</p>
      <Button size="sm" onClick={() => reset()}>
        Tentar de novo
      </Button>
    </section>
  );
}
