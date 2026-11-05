/**
 * Full page load (not a client-side transition). Use after login, logout and account deletion so the session,
 * header and data cache restart for the new state. Same origin only: anything that resolves to another origin
 * (`//evil.com`, `https://evil.com`, `/\evil.com`) goes to the home page instead.
 */
export function hardNavigate(path: string): void {
  const { origin } = window.location;
  let target: URL;
  try {
    target = new URL(path, origin);
  } catch {
    target = new URL("/", origin);
  }
  if (target.origin !== origin) target = new URL("/", origin);
  window.location.assign(target.toString());
}
