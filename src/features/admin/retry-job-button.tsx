"use client";

import { useTransition } from "react";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { retryJob } from "./actions";

export function RetryJobButton({ jobId }: { jobId: string }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            const result = await retryJob(jobId);
            toast(result.ok ? { type: "success", title: "Job reenfileirado" } : { type: "error", title: result.error });
          } catch {
            toast({ type: "error", title: "Sem conexão com o servidor" });
          }
        })
      }
    >
      Tentar de novo
    </Button>
  );
}
