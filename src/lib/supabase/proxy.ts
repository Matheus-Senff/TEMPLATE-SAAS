import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const AUTH_COOKIE = /^sb-.+-auth-token(?:\.\d+)?$/;

/** The request carries a Supabase session cookie (`sb-<project>-auth-token`, possibly split in `.0`, `.1`...). */
export const hasAuthCookie = (request: NextRequest) =>
  request.cookies.getAll().some(({ name }) => AUTH_COOKIE.test(name));

/**
 * Refreshes the Supabase session cookie (when the access token expired) and returns the signed-in user id or
 * null. Follows @supabase/ssr: new cookies go to the request (for this render) and to the response (browser),
 * together with the no-cache headers the library asks for, so no CDN caches a response that sets a session.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet, headers) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          Object.entries(headers ?? {}).forEach(([key, value]) => response.headers.set(key, value));
        },
      },
    },
  );
  const { data } = await supabase.auth.getClaims();
  return { response, userId: (data?.claims?.sub as string | undefined) ?? null };
}

/**
 * Redirect that keeps what updateSession() wrote: a bare NextResponse.redirect() would drop the refreshed
 * cookies, the browser would keep the old (already rotated) refresh token and the user would be signed out.
 */
export function redirectWithSession(url: URL, from: NextResponse): NextResponse {
  const redirect = NextResponse.redirect(url);
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = from.headers.get(header);
    if (value) redirect.headers.set(header, value);
  }
  return redirect;
}
