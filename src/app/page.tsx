import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element -- static logo, must work offline */}
      <img
        src="/brand/logo.jpg"
        alt="The Local Butcher, Argao"
        width={240}
        height={268}
        className="rounded-2xl bg-white p-3 shadow-sm"
      />
      <h1 className="sr-only">The Local Butcher</h1>
      <p className="text-charcoal-500">Where Quality Meets Affordability</p>
      <div className="grid w-full gap-3">
        <Link
          href="/pos"
          className="rounded-xl bg-burgundy-700 px-4 py-4 text-lg font-semibold text-cream-50 hover:bg-burgundy-800"
        >
          Open POS
        </Link>
        <Link
          href="/office"
          className="rounded-xl bg-navy-800 px-4 py-4 text-lg font-semibold text-cream-50 hover:bg-navy-900"
        >
          Back Office
        </Link>
      </div>
    </main>
  );
}
