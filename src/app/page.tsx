import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element -- static icon, must work offline */}
      <img src="/icons/icon-192.png" alt="" width={96} height={96} className="rounded-3xl" />
      <div>
        <h1 className="text-2xl font-bold text-burgundy-800">The Local Butcher</h1>
        <p className="text-charcoal-500">Where Quality Meets Affordability</p>
      </div>
      <div className="grid w-full gap-3">
        <Link
          href="/pos"
          className="rounded-xl bg-burgundy-700 px-4 py-4 text-lg font-semibold text-cream-50 hover:bg-burgundy-800"
        >
          Open POS
        </Link>
        <Link
          href="/office"
          className="rounded-xl border border-cream-300 bg-white px-4 py-4 text-lg font-semibold text-charcoal-700 hover:bg-cream-50"
        >
          Back Office
        </Link>
      </div>
    </main>
  );
}
