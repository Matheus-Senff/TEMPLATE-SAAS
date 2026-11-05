/** Identity used by metadata, sitemap, legal pages and footer. Change per project. */
export const site = {
  name: "Template SaaS",
  description: "Next.js + Supabase + Vercel",
  url: (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000")
  ).replace(/\/+$/, ""),
  locale: "pt_BR",
  company: "[RAZÃO SOCIAL]",
  document: "[CNPJ]",
  contactEmail: "[contato@seudominio.com.br]",
  dpoEmail: "[privacidade@seudominio.com.br]",
  legalUpdatedAt: "[DD/MM/AAAA]",
} as const;

/** Public routes listed in the sitemap. Private areas stay out (see robots.ts). */
export const publicRoutes = ["/", "/contato", "/privacidade", "/termos"] as const;
