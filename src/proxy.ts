import { NextResponse, type NextRequest } from "next/server";
import { hasAuthCookie, redirectWithSession, updateSession } from "@/lib/supabase/proxy";

/** Private areas: keep in sync with `config.matcher` below (and call requireUser()/requireAdmin() in the page). */
const PRIVATE = ["/painel", "/admin", "/redefinir-senha", "/convite", "/dois-fatores"];
const AUTH_PAGES = ["/entrar", "/cadastro"];
const matches = (path: string, prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));

function redirectTo(request: NextRequest, pathname: string, search = "") {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = search;
  return url;
}

/**
 * Runs only where the session matters (see matcher): refreshes the Supabase session on private pages and their
 * Server Actions, and redirects between private and auth pages. Pages still check auth themselves.
 * Without a Supabase cookie there is nothing to refresh: no Auth/JWT work at all.
 */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPrivate = matches(path, PRIVATE);
  // Keeps the query (e.g. /convite?token=...) so the user comes back to the same link after signing in.
  const login = () => redirectTo(request, "/entrar", `?next=${encodeURIComponent(path + request.nextUrl.search)}`);

  if (!hasAuthCookie(request)) return isPrivate ? NextResponse.redirect(login()) : NextResponse.next();

  const { response, userId } = await updateSession(request);
  if (!userId && isPrivate) return redirectWithSession(login(), response);
  if (userId && matches(path, AUTH_PAGES)) return redirectWithSession(redirectTo(request, "/painel"), response);
  return response;
}

export const config = {
  // Public pages are not listed on purpose: they are static, and running the proxy there would turn every view
  // into a function invocation (plus a JWT check). Signed-in visitors on public pages refresh their session in the
  // browser (supabase-js in the header). New private area = add it here AND to PRIVATE.
  matcher: ["/painel/:path*", "/admin/:path*", "/redefinir-senha", "/convite", "/dois-fatores", "/entrar", "/cadastro"],
};
