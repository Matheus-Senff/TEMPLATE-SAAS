import { afterEach, describe, expect, it, vi } from "vitest";
import type * as RateLimitModule from "@/lib/rate-limit";
import { claimsFor, expectRedirect, fakeSupabase, mockAdmin, mockServerClient } from "./helpers/admin-mock";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  for (const mod of [
    "@/lib/supabase/admin",
    "@/lib/supabase/server",
    "@/lib/rate-limit",
    "@/lib/request",
    "@/lib/reauth",
    "@/lib/audit",
    "@/lib/notifications",
    "@/lib/log",
    "next/cache",
  ]) {
    vi.doUnmock(mod);
  }
});

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/**
 * Common doubles: rate limit (`keys` = counters charged, `peeked` = counters only read), IP, audit, logging.
 */
function stubs({ allowed = true, ip = "1.2.3.4", emailAllowed = true } = {}) {
  const keys: string[] = [];
  const peeked: string[] = [];
  const audit = vi.fn(async () => {});
  vi.doMock("@/lib/rate-limit", async (orig) => ({
    ...(await orig<typeof RateLimitModule>()),
    rateLimit: vi.fn(async (key: string) => {
      keys.push(key);
      return { allowed, remaining: 0, resetAt: new Date() };
    }),
    rateLimitAll: vi.fn(async (checks: Array<readonly [string, number, number]>) => {
      keys.push(...checks.map(([key]) => key));
      return allowed;
    }),
    rateLimitPeek: vi.fn(async (key: string) => {
      peeked.push(key);
      return emailAllowed;
    }),
  }));
  vi.doMock("@/lib/request", () => ({ clientIp: async () => ip }));
  vi.doMock("@/lib/audit", () => ({ audit }));
  vi.doMock("@/lib/log", () => ({ reportError: vi.fn() }));
  mockAdmin();
  return { keys, peeked, audit };
}

describe("signIn", () => {
  it("sends the captcha token to Supabase, charges the IP and only checks the (hashed) e-mail counter", async () => {
    const { keys, peeked } = stubs();
    const { client } = mockServerClient();
    const { signIn } = await import("@/features/auth/actions");
    const result = await signIn({ email: "Ana@X.com", password: "secret" }, "tok", "/painel/seguranca");
    expect(result).toEqual({ ok: true, data: { redirectTo: "/painel/seguranca" } });
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "ana@x.com",
      password: "secret",
      options: { captchaToken: "tok" },
    });
    expect(keys).toEqual(["signin:ip:1.2.3.4"]);
    expect(peeked[0]).toMatch(/^signin:email:[0-9a-f]{32}$/);
    expect([...keys, ...peeked].join()).not.toContain("ana@x.com");
  });

  it.each([
    ["captcha_failed", 400],
    ["over_request_rate_limit", 429],
  ])(
    "never spends the victim's e-mail budget when Supabase refuses with %s (targeted lockout)",
    async (code, status) => {
      const { keys } = stubs();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockServerClient({
        auth: { signInWithPassword: vi.fn(async () => ({ data: {}, error: { code, status, message: "x" } })) },
      });
      const { signIn } = await import("@/features/auth/actions");
      await signIn({ email: "vitima@x.com", password: "chute" });
      expect(keys.filter((key) => key.startsWith("signin:email:"))).toEqual([]);
    },
  );

  it("charges the e-mail counter only for a wrong password (captcha already accepted)", async () => {
    const { keys } = stubs();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockServerClient({
      auth: {
        signInWithPassword: vi.fn(async () => ({
          data: {},
          error: { code: "invalid_credentials", status: 400, message: "x" },
        })),
      },
    });
    const { signIn } = await import("@/features/auth/actions");
    await signIn({ email: "ana@x.com", password: "errada" });
    expect(keys.filter((key) => key.startsWith("signin:email:"))).toHaveLength(1);
  });

  it("refuses an e-mail over its limit before calling Auth", async () => {
    stubs({ emailAllowed: false });
    const { client } = mockServerClient();
    const { signIn } = await import("@/features/auth/actions");
    expect((await signIn({ email: "ana@x.com", password: "x" })).ok).toBe(false);
    expect(client.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("sends users with an authenticator to the code step after the password", async () => {
    stubs();
    mockServerClient({
      auth: {
        signInWithPassword: vi.fn(async () => ({
          data: { session: {}, user: { factors: [{ id: "f1", status: "verified" }] } },
          error: null,
        })),
      },
    });
    const { signIn } = await import("@/features/auth/actions");
    expect(await signIn({ email: "ana@x.com", password: "x" }, "tok", "/painel/seguranca")).toEqual({
      ok: true,
      data: { redirectTo: "/dois-fatores?next=%2Fpainel%2Fseguranca" },
    });
  });

  it("uses no IP key when the IP is not trustworthy (off Vercel)", async () => {
    const { keys, peeked } = stubs({ ip: "unknown" });
    mockServerClient();
    const { signIn } = await import("@/features/auth/actions");
    await signIn({ email: "ana@x.com", password: "secret" });
    expect(keys).toEqual([]);
    expect(peeked[0]).toMatch(/^signin:email:/);
  });

  it("refuses when a limit is exceeded, without calling Auth", async () => {
    stubs({ allowed: false });
    const { client } = mockServerClient();
    const { signIn } = await import("@/features/auth/actions");
    expect(await signIn({ email: "ana@x.com", password: "x" })).toMatchObject({ ok: false });
    expect(client.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_credentials", 400, "E-mail ou senha incorretos."],
    ["captcha_failed", 400, "robô"],
    ["over_request_rate_limit", 429, "Muitas tentativas"],
    ["email_not_confirmed", 400, "Confirme seu e-mail"],
  ])("maps %s to a clear message", async (code, status, message) => {
    stubs();
    mockServerClient({
      auth: { signInWithPassword: vi.fn(async () => ({ data: {}, error: { code, status, message: "x" } })) },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { signIn } = await import("@/features/auth/actions");
    const result = await signIn({ email: "ana@x.com", password: "x" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });

  it("never redirects outside the site after login", async () => {
    stubs();
    mockServerClient();
    const { signIn } = await import("@/features/auth/actions");
    expect(await signIn({ email: "ana@x.com", password: "x" }, undefined, "/.//evil.com")).toEqual({
      ok: true,
      data: { redirectTo: "/painel" },
    });
  });
});

describe("signUp", () => {
  const input = { fullName: "Ana", email: "ana@x.com", password: "12345678" };

  it("answers like a new sign-up for an existing e-mail (no account enumeration)", async () => {
    stubs();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockServerClient({
      auth: { signUp: vi.fn(async () => ({ data: {}, error: { code: "user_already_exists", status: 422 } })) },
    });
    const { signUp } = await import("@/features/auth/actions");
    expect(await signUp(input, "tok")).toEqual({ ok: true });
  });

  it.each([
    [{ code: "over_email_send_rate_limit", status: 429 }, "Muitos e-mails"],
    [{ code: "unexpected_failure", status: 500, message: "Error sending confirmation email" }, "enviar o e-mail"],
    [{ code: "email_address_not_authorized", status: 400 }, "enviar o e-mail"],
  ])("explains e-mail delivery problems (%j)", async (error, message) => {
    stubs();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockServerClient({ auth: { signUp: vi.fn(async () => ({ data: {}, error })) } });
    const { signUp } = await import("@/features/auth/actions");
    const result = await signUp(input, "tok");
    expect(!result.ok && result.error).toContain(message);
  });

  it("passes the captcha token and charges the e-mail only after Supabase accepted it", async () => {
    const { keys } = stubs();
    const { client } = mockServerClient();
    const { signUp } = await import("@/features/auth/actions");
    await signUp(input, "tok");
    expect(client.auth.signUp).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ captchaToken: "tok" }) }),
    );
    expect(keys.map((k) => k.split(":").slice(0, 2).join(":"))).toEqual(["signup:ip", "signup:email"]);
  });

  it("does not charge the e-mail when the captcha is missing or invalid", async () => {
    const { keys } = stubs();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockServerClient({
      auth: { signUp: vi.fn(async () => ({ data: {}, error: { code: "captcha_failed", status: 400 } })) },
    });
    const { signUp } = await import("@/features/auth/actions");
    await signUp(input);
    expect(keys).toEqual(["signup:ip:1.2.3.4"]);
  });
});

describe("requestPasswordReset", () => {
  it("does not reveal unknown e-mails", async () => {
    stubs();
    mockServerClient({
      auth: {
        resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: { code: "user_not_found", status: 400 } })),
      },
    });
    const { requestPasswordReset } = await import("@/features/auth/actions");
    expect(await requestPasswordReset({ email: "x@x.com" }, "tok")).toEqual({ ok: true });
  });

  it("shows captcha problems (the user can fix them)", async () => {
    stubs();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockServerClient({
      auth: {
        resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: { code: "captcha_failed", status: 400 } })),
      },
    });
    const { requestPasswordReset } = await import("@/features/auth/actions");
    expect((await requestPasswordReset({ email: "x@x.com" }, "tok")).ok).toBe(false);
  });
});

describe("changePassword", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const setup = (claims: Record<string, unknown>, verify?: unknown, auth: Record<string, unknown> = {}) => {
    const { audit } = stubs();
    const server = mockServerClient({ claims, auth });
    const fresh = fakeSupabase();
    const verifyPassword = vi.fn(async () => verify ?? { ok: true, client: fresh.client });
    vi.doMock("@/lib/reauth", () => ({ verifyPassword }));
    return { server, fresh, verifyPassword, audit };
  };

  it("requires the current password on a normal session", async () => {
    const { verifyPassword } = setup(claimsFor(USER));
    const { changePassword } = await import("@/features/auth/actions");
    const result = await changePassword({ password: "nova-senha-1" });
    expect(result.ok).toBe(false);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("rejects a wrong current password", async () => {
    const { server } = setup(claimsFor(USER), { ok: false, code: "invalid_credentials", status: 400 });
    const { changePassword } = await import("@/features/auth/actions");
    const result = await changePassword({ currentPassword: "errada", password: "nova-senha-1" }, "tok");
    expect(result).toMatchObject({ ok: false, fieldErrors: { currentPassword: ["Senha atual incorreta"] } });
    expect(server.client.auth.updateUser).not.toHaveBeenCalled();
  });

  it("re-authenticates, updates and signs out every other session", async () => {
    const { server, verifyPassword, audit } = setup(claimsFor(USER));
    const { changePassword } = await import("@/features/auth/actions");
    const result = await changePassword({ currentPassword: "atual", password: "nova-senha-1" }, "tok");
    expect(result).toEqual({ ok: true, data: { redirectTo: "/painel" } });
    expect(verifyPassword).toHaveBeenCalledWith(`${USER}@x.com`, "atual", "tok");
    expect(server.client.auth.updateUser).toHaveBeenCalledWith({ password: "nova-senha-1" });
    expect(server.client.auth.signOut).toHaveBeenCalledWith({ scope: "others" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "user.password_changed" }));
  });

  it("uses the fresh re-authenticated session when Supabase asks for reauthentication (session > 24h)", async () => {
    const reauth = vi.fn(async () => ({ data: {}, error: { code: "reauthentication_needed", status: 400 } }));
    const { server, fresh } = setup(claimsFor(USER), undefined, { updateUser: reauth });
    const { changePassword } = await import("@/features/auth/actions");
    expect((await changePassword({ currentPassword: "atual", password: "nova-senha-1" })).ok).toBe(true);
    expect(fresh.client.auth.updateUser).toHaveBeenCalledWith({ password: "nova-senha-1" });
    expect(server.client.auth.signOut).toHaveBeenCalledWith({ scope: "others" });
  });

  it("accepts only the new password in a fresh recovery-link session", async () => {
    const { server, verifyPassword } = setup(claimsFor(USER, { amr: [{ method: "recovery", timestamp: now() }] }));
    const { changePassword } = await import("@/features/auth/actions");
    expect((await changePassword({ password: "nova-senha-1" })).ok).toBe(true);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(server.client.auth.signOut).toHaveBeenCalledWith({ scope: "others" });
  });

  it("asks for the current password again when the recovery link is older than 1h", async () => {
    setup(claimsFor(USER, { amr: [{ method: "recovery", timestamp: now() - 2 * 3600 }] }));
    const { changePassword } = await import("@/features/auth/actions");
    expect((await changePassword({ password: "nova-senha-1" })).ok).toBe(false);
  });
});

describe("confirmEmailLink (POST step of /auth/confirm)", () => {
  const form = (values: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.set(key, value);
    return data;
  };

  it("spends the token only on POST and goes to a safe `next`", async () => {
    stubs();
    const { client } = mockServerClient();
    const { confirmEmailLink } = await import("@/features/auth/actions");
    const target = await expectRedirect(confirmEmailLink(form({ token_hash: "h", type: "email", next: "/painel" })));
    expect(target).toBe("/painel");
    expect(client.auth.verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: "h" });
  });

  it.each([
    [{ token_hash: "h", type: "recovery", next: "/painel" }, "/redefinir-senha"],
    [{ token_hash: "h", type: "email", next: "/.//evil.com" }, "/painel"],
    [{ token_hash: "h", type: "evil" }, "/entrar?erro=link"],
  ])("%j -> %s", async (values, expected) => {
    stubs();
    mockServerClient();
    const { confirmEmailLink } = await import("@/features/auth/actions");
    expect(await expectRedirect(confirmEmailLink(form(values)))).toBe(expected);
  });

  it("sends expired links back to the login with an error", async () => {
    stubs();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockServerClient({
      auth: { verifyOtp: vi.fn(async () => ({ data: {}, error: { code: "otp_expired", status: 403 } })) },
    });
    const { confirmEmailLink } = await import("@/features/auth/actions");
    expect(await expectRedirect(confirmEmailLink(form({ token_hash: "h", type: "email" })))).toBe("/entrar?erro=link");
  });
});

describe("/auth/callback", () => {
  const get = async (query: string, error: unknown = null) => {
    mockServerClient({ auth: { exchangeCodeForSession: vi.fn(async () => ({ data: {}, error })) } });
    const { GET } = await import("@/app/auth/callback/route");
    const res = await GET(new Request(`https://app.test/auth/callback?${query}`) as never);
    return res.headers.get("location");
  };

  it("exchanges the code and goes to the internal `next`", async () => {
    expect(await get("code=c&next=/painel/seguranca")).toBe("https://app.test/painel/seguranca");
  });

  it("never leaves the site", async () => {
    expect(await get(`code=c&next=${encodeURIComponent("/.//evil.com")}`)).toBe("https://app.test/painel");
  });

  it("sends invalid codes to the login with an error", async () => {
    expect(await get("code=c", { message: "invalid" })).toBe("https://app.test/entrar?erro=link");
    vi.resetModules();
    expect(await get("next=/painel")).toBe("https://app.test/entrar?erro=link");
  });
});

describe("requireUser / requireAdmin", () => {
  it("sends signed-out visitors to the login with `next`", async () => {
    mockServerClient({ claims: null });
    const { requireUser } = await import("@/lib/auth");
    expect(await expectRedirect(requireUser("/painel/seguranca"))).toBe("/entrar?next=%2Fpainel%2Fseguranca");
  });

  it("sends members back to the dashboard", async () => {
    mockServerClient({ claims: claimsFor(USER), results: { profiles: [{ data: { role: "member" }, error: null }] } });
    const { requireAdmin } = await import("@/lib/auth");
    expect(await expectRedirect(requireAdmin())).toBe("/painel");
  });

  it("refuses admins without a factor at aal1, with no self-enrolment path", async () => {
    vi.stubEnv("ADMIN_REQUIRE_MFA", "true");
    mockServerClient({ claims: claimsFor(USER), results: { profiles: [{ data: { role: "admin" }, error: null }] } });
    const { requireAdmin } = await import("@/lib/auth");
    expect(await expectRedirect(requireAdmin())).toBe("/painel/seguranca?mfa=admin-sem-fator");
  });

  it("refuses an aal2 admin whose factor was enrolled after the promotion (takeover by enrolment)", async () => {
    vi.stubEnv("ADMIN_REQUIRE_MFA", "true");
    mockServerClient({
      claims: claimsFor(USER, { aal: "aal2" }),
      results: { profiles: [{ data: { role: "admin" }, error: null }] },
      rpc: { admin_mfa_trusted: { data: false, error: null } },
    });
    const { requireAdmin } = await import("@/lib/auth");
    expect(await expectRedirect(requireAdmin())).toBe("/painel/seguranca?mfa=admin-sem-fator");
  });

  it("sends a password-only session of a user with an authenticator to the code step", async () => {
    mockServerClient({ claims: claimsFor(USER), rpc: { mfa_satisfied: { data: false, error: null } } });
    const { requireUser } = await import("@/lib/auth");
    expect(await expectRedirect(requireUser("/painel"))).toBe("/dois-fatores?next=%2Fpainel");
  });

  it("does not ask the database again for aal2 sessions", async () => {
    const { client } = mockServerClient({ claims: claimsFor(USER, { aal: "aal2" }) });
    const { requireUser } = await import("@/lib/auth");
    expect((await requireUser()).id).toBe(USER);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("lets admins with aal2 in", async () => {
    vi.stubEnv("ADMIN_REQUIRE_MFA", "true");
    mockServerClient({
      claims: claimsFor(USER, { aal: "aal2" }),
      results: { profiles: [{ data: { role: "admin" }, error: null }] },
    });
    const { requireAdmin } = await import("@/lib/auth");
    expect((await requireAdmin()).id).toBe(USER);
  });

  it("does not require aal2 when the flag is off", async () => {
    vi.stubEnv("ADMIN_REQUIRE_MFA", "false");
    mockServerClient({ claims: claimsFor(USER), results: { profiles: [{ data: { role: "admin" }, error: null }] } });
    const { requireAdmin } = await import("@/lib/auth");
    expect((await requireAdmin()).aal).toBe("aal1");
  });
});

describe("setUserRole", () => {
  const setup = (claims: Record<string, unknown>, role = "admin", targetHasMfa = true) => {
    vi.stubEnv("ADMIN_REQUIRE_MFA", "true");
    const { audit } = stubs();
    const admin = mockAdmin(
      { profiles: [{ data: null, error: null }] },
      { user_has_verified_mfa: { data: targetHasMfa, error: null } },
    );
    const notify = vi.fn(async () => true);
    vi.doMock("@/lib/notifications", () => ({ notify }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    mockServerClient({ claims, results: { profiles: [{ data: { role }, error: null }] } });
    return { audit, admin, notify };
  };

  it("only promotes people who already have two-step verification", async () => {
    const { admin } = setup(claimsFor(USER, { aal: "aal2" }), "admin", false);
    const { setUserRole } = await import("@/features/admin/actions");
    expect(await setUserRole({ userId: OTHER, role: "admin" })).toMatchObject({ ok: false });
    expect(admin.calls.some((c) => c.table === "profiles" && c.method === "update")).toBe(false);
  });

  it("is admin-only", async () => {
    setup(claimsFor(USER, { aal: "aal2" }), "member");
    const { setUserRole } = await import("@/features/admin/actions");
    expect(await expectRedirect(setUserRole({ userId: OTHER, role: "admin" }))).toBe("/painel");
  });

  it("requires the second factor before changing roles", async () => {
    setup(claimsFor(USER));
    const { setUserRole } = await import("@/features/admin/actions");
    expect(await expectRedirect(setUserRole({ userId: OTHER, role: "admin" }))).toContain("/painel/seguranca");
  });

  it("refuses to change the admin's own role", async () => {
    setup(claimsFor(USER, { aal: "aal2" }));
    const { setUserRole } = await import("@/features/admin/actions");
    expect(await setUserRole({ userId: USER, role: "member" })).toEqual({
      ok: false,
      error: "Você não pode alterar o próprio papel.",
    });
  });

  it("changes the role, audits and notifies", async () => {
    const { audit, admin, notify } = setup(claimsFor(USER, { aal: "aal2" }));
    const { setUserRole } = await import("@/features/admin/actions");
    expect(await setUserRole({ userId: OTHER, role: "admin" })).toEqual({ ok: true });
    expect(admin.calls).toContainEqual({ table: "profiles", method: "update", args: [{ role: "admin" }] });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "user.role_changed", entityId: OTHER }));
    expect(notify).toHaveBeenCalledWith(OTHER, expect.objectContaining({ title: "Você agora é administrador" }));
  });
});

describe("startMfaEnrollment (first authenticator)", () => {
  const enrollment = { id: "f1", totp: { qr_code: "<svg/>", secret: "SECRET", uri: "otpauth://" } };
  const setup = ({ role = "member", verify = { ok: true, client: fakeSupabase().client } as unknown } = {}) => {
    const { audit } = stubs();
    const server = mockServerClient({
      claims: claimsFor(USER),
      results: { profiles: [{ data: { role }, error: null }] },
    });
    const mfa = {
      listFactors: vi.fn(async () => ({ data: { all: [{ id: "old", status: "unverified" }], totp: [] }, error: null })),
      unenroll: vi.fn(async () => ({ data: {}, error: null })),
      enroll: vi.fn(async () => ({ data: enrollment, error: null })),
    };
    (server.client.auth as unknown as { mfa: typeof mfa }).mfa = mfa;
    const verifyPassword = vi.fn(async () => verify);
    vi.doMock("@/lib/reauth", () => ({ verifyPassword }));
    return { mfa, verifyPassword, audit };
  };

  it("re-checks the password before creating the factor on this session", async () => {
    const { mfa, verifyPassword } = setup();
    const { startMfaEnrollment } = await import("@/features/auth/actions");
    expect(await startMfaEnrollment({ password: "certa" }, "tok")).toEqual({
      ok: true,
      data: { factorId: "f1", qr: "<svg/>", secret: "SECRET" },
    });
    expect(verifyPassword).toHaveBeenCalledWith(`${USER}@x.com`, "certa", "tok");
    expect(mfa.unenroll).toHaveBeenCalledWith({ factorId: "old" });
    expect(mfa.enroll).toHaveBeenCalledWith({ factorType: "totp", friendlyName: "Autenticador" });
  });

  it("refuses a wrong password (a stolen session alone cannot attach an authenticator)", async () => {
    const { mfa } = setup({ verify: { ok: false, code: "invalid_credentials", status: 400 } });
    const { startMfaEnrollment } = await import("@/features/auth/actions");
    expect(await startMfaEnrollment({ password: "errada" })).toMatchObject({ ok: false });
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  it("refuses admin accounts: their factor must exist before the promotion", async () => {
    const { mfa, verifyPassword } = setup({ role: "admin" });
    const { startMfaEnrollment } = await import("@/features/auth/actions");
    expect(await startMfaEnrollment({ password: "certa" })).toMatchObject({ ok: false });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(mfa.enroll).not.toHaveBeenCalled();
  });
});
