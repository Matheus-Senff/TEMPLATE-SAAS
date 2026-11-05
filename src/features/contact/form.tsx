"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { useToast } from "@/components/toast";
import { Turnstile, turnstileEnabled } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { sendContact } from "./actions";
import { contactSchema, type ContactInput } from "./schema";

/** Reference form: zod in the browser and in the Server Action, Turnstile, toasts and pending state. */
export function ContactForm() {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const form = useForm<ContactInput>({
    resolver: zodResolver(contactSchema),
    defaultValues: { name: "", email: "", phone: "", message: "", website: "" },
  });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit((values) =>
    startTransition(async () => {
      if (turnstileEnabled && !captcha) return toast({ type: "warning", title: "Confirme que você não é um robô" });
      const result = await sendContact(values, captcha ?? undefined);
      setResetKey((k) => k + 1);
      if (result.ok) {
        toast({ type: "success", title: "Mensagem enviada", body: "Responderemos em breve." });
        form.reset();
      } else {
        toast({ type: "error", title: "Não foi possível enviar", body: result.error });
      }
    }),
  );

  return (
    <form noValidate className="space-y-4" onSubmit={onSubmit}>
      <Field label="Nome" required error={errors.name?.message}>
        <Input autoComplete="name" {...form.register("name")} />
      </Field>
      <Field label="E-mail" required error={errors.email?.message}>
        <Input type="email" autoComplete="email" {...form.register("email")} />
      </Field>
      <Field label="Telefone" hint="Opcional" error={errors.phone?.message}>
        <Input type="tel" autoComplete="tel" inputMode="tel" {...form.register("phone")} />
      </Field>
      <Field label="Mensagem" required error={errors.message?.message}>
        <Textarea rows={5} {...form.register("message")} />
      </Field>
      <input
        type="text"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
        {...form.register("website")}
      />
      <Turnstile onToken={setCaptcha} resetKey={resetKey} />
      <Button type="submit" loading={pending}>
        Enviar mensagem
      </Button>
    </form>
  );
}
