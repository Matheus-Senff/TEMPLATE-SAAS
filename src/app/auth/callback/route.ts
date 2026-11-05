import { NextResponse, type NextRequest } from "next/server";
import { safePath } from "@/lib/redirect";
import { createClient } from "@/lib/supabase/server";

/** OAuth and e-mail links (PKCE): exchanges the code for a session, then goes to `next`. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safePath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`${origin}/entrar?erro=link`);
}
