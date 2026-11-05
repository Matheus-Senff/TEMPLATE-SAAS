"use client";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useToast, type ToastType } from "@/components/toast";
import { useSession } from "@/components/use-session";
import type { Tables } from "@/lib/supabase/database.types";
import { queryKeys } from "@/lib/query-keys";
import { isSafePath } from "@/lib/redirect";
import { createClient } from "@/lib/supabase/client";

type Item = Tables<"notifications">;
type Broadcast = Pick<Item, "id" | "type" | "title" | "body" | "link" | "created_at">;
const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

/**
 * Bell for the signed-in user. Reads with RLS (own rows only) and joins the private Realtime Broadcast channel
 * `user:<id>:notifications`, fed by a database trigger on every `notify()` (`broadcast_notification()` in
 * supabase/migrations). Joining is authorized once by the RLS policy on realtime.messages,
 * instead of an RLS check per subscriber per row as with postgres_changes. New notifications also show a toast.
 */
export function NotificationBell() {
  const { user } = useSession();
  const toast = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const supabase = createClient();
  const key = queryKeys.notifications.list(user?.id ?? "");

  const { data } = useQuery({
    queryKey: key,
    enabled: Boolean(user),
    queryFn: async () => {
      const [list, unread] = await Promise.all([
        supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(10),
        supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null),
      ]);
      if (list.error) throw list.error;
      return { items: list.data, unread: unread.count ?? 0 };
    },
  });

  useEffect(() => {
    if (!user) return;
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    void (async () => {
      // Private channels are authorized with the user's JWT.
      await supabase.realtime.setAuth();
      if (cancelled) return;
      channel = supabase
        .channel(`user:${user.id}:notifications`, { config: { private: true } })
        .on("broadcast", { event: "notification_created" }, ({ payload }) => {
          const item = payload as Broadcast;
          toast({ type: item.type as ToastType, title: item.title, body: item.body });
          void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
        })
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [user, supabase, toast, queryClient]);

  const markRead = useMutation({
    mutationFn: async (ids: string[] | "all") => {
      const query = supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
      const { error } = ids === "all" ? await query : await query.in("id", ids);
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;
  const items = data?.items ?? [];
  const unread = data?.unread ?? 0;

  function openItem(item: Item) {
    if (!item.read_at) markRead.mutate([item.id]);
    if (isSafePath(item.link)) {
      setOpen(false);
      router.push(item.link);
    }
  }

  return (
    <div className="relative" ref={panel}>
      <button
        aria-label={unread > 0 ? `Notificações: ${unread} não lidas` : "Notificações"}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative rounded-md p-1.5 hover:bg-neutral-200 dark:hover:bg-neutral-800"
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] leading-4 font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
            <p className="text-sm font-semibold">Notificações</p>
            {unread > 0 && (
              <button className="text-xs text-neutral-500 hover:underline" onClick={() => markRead.mutate("all")}>
                Marcar todas como lidas
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-neutral-500">Nenhuma notificação.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    className="flex w-full gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    onClick={() => openItem(item)}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.read_at ? "bg-transparent" : "bg-blue-600"}`}
                    />
                    <span className="min-w-0">
                      <span className={`block ${item.read_at ? "" : "font-medium"}`}>{item.title}</span>
                      {item.body && <span className="block text-neutral-600 dark:text-neutral-400">{item.body}</span>}
                      <span className="block text-xs text-neutral-400">
                        {dateFormat.format(new Date(item.created_at))}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
