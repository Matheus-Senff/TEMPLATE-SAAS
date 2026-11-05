"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/input";
import { setUserRole } from "./actions";

const label: Record<string, string> = { admin: "Admin", member: "Membro" };

/**
 * Role picker with explicit confirmation: changing the select (including with arrow keys) only opens a dialog;
 * the role changes on "Confirmar". Cancel or Esc keeps the current role.
 */
export function RoleSelect({
  userId,
  role,
  name,
  disabled,
}: {
  userId: string;
  role: string;
  name?: string | null;
  disabled?: boolean;
}) {
  const toast = useToast();
  const [current, setCurrent] = useState(role);
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const confirm = () =>
    startTransition(async () => {
      if (!pendingRole) return;
      try {
        const result = await setUserRole({ userId, role: pendingRole });
        if (result.ok) {
          setCurrent(pendingRole);
          toast({ type: "success", title: "Papel atualizado" });
        } else {
          toast({ type: "error", title: result.error });
        }
      } catch {
        toast({ type: "error", title: "Sem conexão com o servidor", body: "O papel não foi alterado." });
      }
      setPendingRole(null);
    });

  const who = name || "este usuário";
  return (
    <>
      <Select
        aria-label="Papel"
        className="h-8 w-32"
        value={pendingRole ?? current}
        disabled={disabled || pending}
        onChange={(e) => {
          if (e.target.value !== current) setPendingRole(e.target.value);
        }}
      >
        <option value="member">Membro</option>
        <option value="admin">Admin</option>
      </Select>
      <Dialog open={pendingRole !== null} onClose={() => !pending && setPendingRole(null)} title="Alterar papel?">
        <p className="text-sm">
          {pendingRole === "admin"
            ? `Tornar ${who} administrador? Administradores veem e gerenciam todos os usuários.`
            : `Remover o acesso de administrador de ${who}?`}
        </p>
        <p className="text-sm text-neutral-500">
          De {label[current] ?? current} para {label[pendingRole ?? ""] ?? pendingRole}.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => setPendingRole(null)}>
            Cancelar
          </Button>
          <Button
            size="sm"
            variant={pendingRole === "admin" ? "danger" : "primary"}
            loading={pending}
            onClick={confirm}
          >
            Confirmar
          </Button>
        </div>
      </Dialog>
    </>
  );
}
