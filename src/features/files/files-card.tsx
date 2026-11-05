"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useSession } from "@/components/use-session";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Skeleton } from "@/components/ui/misc";
import { TBody, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { queryKeys } from "@/lib/query-keys";
import { createClient } from "@/lib/supabase/client";
import { ALLOWED_MIME_TYPES, buildObjectPath, FILES_BUCKET, validateFile } from "./config";

const PAGE = 10;
const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

/** Upload straight to Supabase Storage (RLS: own folder only) + paginated list with TanStack Query. */
export function FilesCard() {
  const { user } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const supabase = createClient();

  const files = useInfiniteQuery({
    queryKey: queryKeys.files.list(user?.id ?? ""),
    enabled: Boolean(user),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await supabase.storage
        .from(FILES_BUCKET)
        .list(user!.id, { limit: PAGE, offset: pageParam, sortBy: { column: "created_at", order: "desc" } });
      if (error) throw error;
      return data;
    },
    getNextPageParam: (last, pages) => (last.length === PAGE ? pages.length * PAGE : undefined),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const invalid = validateFile(file);
      if (invalid) throw new Error(invalid);
      const { error } = await supabase.storage
        .from(FILES_BUCKET)
        .upload(buildObjectPath(user!.id, file.name), file, { contentType: file.type, upsert: false });
      if (error) throw error;
    },
    onSuccess: (_data, file) => {
      toast({ type: "success", title: "Arquivo enviado", body: file.name });
      void queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
    },
    onError: (error) => toast({ type: "error", title: "Falha no envio", body: error.message }),
    onSettled: () => {
      if (input.current) input.current.value = "";
    },
  });

  async function download(name: string) {
    const { data, error } = await supabase.storage
      .from(FILES_BUCKET)
      .createSignedUrl(`${user!.id}/${name}`, 60, { download: true });
    if (error) return toast({ type: "error", title: "Não foi possível baixar", body: error.message });
    window.location.assign(data.signedUrl);
  }

  const items = files.data?.pages.flat() ?? [];

  return (
    <Card title="Arquivos">
      <div className="flex items-center gap-2">
        <input
          ref={input}
          type="file"
          accept={ALLOWED_MIME_TYPES.join(",")}
          className="block text-sm"
          onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])}
          disabled={upload.isPending || !user}
        />
        {upload.isPending && <span className="text-sm text-neutral-500">Enviando...</span>}
      </div>
      {files.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : files.isError ? (
        <EmptyState
          title="Não foi possível carregar"
          action={
            <Button size="sm" variant="secondary" onClick={() => files.refetch()}>
              Tentar de novo
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState title="Nenhum arquivo ainda" description="Envie o primeiro arquivo acima." />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Arquivo</TH>
                <TH>Enviado em</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {items.map((file) => (
                <TR key={file.id ?? file.name}>
                  <TD className="max-w-48 truncate">{file.name.replace(/^[0-9a-f-]{36}-/, "")}</TD>
                  <TD>{file.created_at ? dateFormat.format(new Date(file.created_at)) : "-"}</TD>
                  <TD>
                    <Button size="sm" variant="link" onClick={() => download(file.name)}>
                      Baixar
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {files.hasNextPage && (
            <Button
              variant="secondary"
              size="sm"
              loading={files.isFetchingNextPage}
              onClick={() => files.fetchNextPage()}
            >
              Carregar mais
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
