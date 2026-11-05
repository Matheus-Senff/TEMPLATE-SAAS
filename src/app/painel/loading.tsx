import { Skeleton } from "@/components/ui/misc";

export default function Loading() {
  return (
    <section className="space-y-6" aria-busy="true" aria-label="Carregando">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-36" />
        ))}
      </div>
    </section>
  );
}
