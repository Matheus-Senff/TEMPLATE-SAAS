import { AppProviders } from "@/components/app-providers";

/** Signed-in area: data cache (TanStack Query) for this subtree only, so public pages do not ship it. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
