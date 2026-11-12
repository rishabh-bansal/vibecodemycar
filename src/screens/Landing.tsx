import { Link } from '@tanstack/react-router';
import { POLICY } from '../config/policy.ts';
import { featuresFor } from '../domain/catalog/features.ts';
import type { CarSelection } from '../domain/catalog/types.ts';
import { BRAND_OPTIONS, modelsFor } from '../domain/catalog/vehicles.ts';
import { useCarStore } from '../state/car-store.ts';
import { Button } from '../ui/Button.tsx';
import { FeatureRow } from '../ui/FeatureRow.tsx';
import { Logo } from '../ui/Logo.tsx';
import { Micro } from '../ui/Panels.tsx';

/** Sample car for the landing preview. */
const SAMPLE_CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};

const TRUST = ['No account', 'No subscription', 'Undo anytime', 'Every change checked'];
const STEPS = [
  { t: 'Pick your car', d: "Brand and model. See what's available for your car." },
  { t: 'Choose one feature', d: "See what it does and whether it's available for your car." },
  {
    t: 'Connect & unlock',
    d: 'Plug in a Bluetooth adapter. We save your original setting, make the change, then check it worked.',
  },
];
const SAFETY = [
  {
    i: '↺',
    t: 'Original saved, every time',
    d: 'Your original setting is saved before every change, so you can always undo it.',
  },
  {
    i: '✓',
    t: 'Checked, not guessed',
    d: 'After every change we ask your car to confirm it took.',
  },
  {
    i: '◎',
    t: 'Made for your car',
    d: "See what's available for your model. Your car tells us the rest when you connect.",
  },
];

/** Public landing page. Every number and car on it comes from the same data the app uses. */
export function Landing() {
  const setBrand = useCarStore((s) => s.setBrand);
  const setModel = useCarStore((s) => s.setModel);
  const preview = featuresFor(SAMPLE_CAR).slice(0, 3);

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 lg:px-8">
        <Logo size={22} className="text-lg" />
        <nav
          aria-label="Site"
          className="flex items-center gap-2 font-extrabold text-[11px] tracking-[1.5px]"
        >
          <a href="#cars" className="hidden px-3 py-2.5 text-ink no-underline sm:block">
            CARS
          </a>
          <a href="#how" className="hidden px-3 py-2.5 text-ink no-underline sm:block">
            HOW IT WORKS
          </a>
          <Link
            to="/car"
            className="plunk bg-ink px-3.5 py-2.5 text-bg no-underline [--edge:var(--color-ink-4)] [--plunk:3px]"
          >
            OPEN APP
          </Link>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pt-8 pb-14 lg:grid-cols-[1.1fr_1fr] lg:px-8 lg:pt-16">
          <div className="flex flex-col gap-6">
            <span className="self-start bg-green px-2.5 py-1.5 font-extrabold text-[11px] text-bg tracking-[1.5px]">
              FREE · ŠKODA & VW · INDIA
            </span>
            <h1 className="display m-0 text-[52px] lg:text-[96px]">
              your car
              <br />
              can do more.
              <br />
              <span className="text-yellow">turn it on.</span>
            </h1>
            <p className="m-0 max-w-md text-base text-ink-2 leading-[1.55]">
              Unlock hidden features already built into your car, from your phone. No technician, no
              appointment, no fee.
            </p>
            <div className="flex flex-col gap-3.5 sm:flex-row">
              <Button asChild className="sm:min-w-64">
                <Link to="/car">Find my features →</Link>
              </Button>
              <Button asChild variant="secondary" className="sm:w-auto sm:px-8">
                <a href={POLICY.adapterShopUrl} target="_blank" rel="noopener noreferrer sponsored">
                  Get an adapter ↗
                </a>
              </Button>
            </div>
          </div>

          <div className="plunk flex flex-col gap-4 border border-line bg-surface p-5 [--edge:var(--color-yellow-edge)] [--plunk:10px]">
            <div className="flex items-center justify-between">
              <Micro>KUSHAQ MONTE CARLO · EXAMPLE</Micro>
            </div>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {preview.map((f) => (
                <FeatureRow
                  key={f.id}
                  feature={f}
                  label={f.tier === 'unavailable' ? 'NOT AVAILABLE' : 'AVAILABLE'}
                />
              ))}
            </ul>
            <p className="m-0 font-extrabold text-[11px] text-green tracking-[1px]">
              ✓ ORIGINAL SAVED · UNDO ANYTIME
            </p>
          </div>
        </section>

        <section aria-label="Promises" className="bg-yellow py-4 text-bg">
          <ul className="mx-auto m-0 flex max-w-6xl list-none flex-wrap justify-center gap-x-8 gap-y-2 px-5 font-extrabold text-xs tracking-[2px] uppercase">
            {TRUST.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>

        <section id="cars" className="mx-auto max-w-6xl px-5 py-16 lg:px-8">
          {/* The car screen says what each model can unlock. */}
          <Micro>Cars</Micro>
          <h2 className="display mt-2 mb-8 text-[44px]">pick your car.</h2>
          <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4">
            {BRAND_OPTIONS.flatMap((b) =>
              modelsFor(b.id).map((m) => (
                <li key={`${b.id}-${m.id}`}>
                  <Link
                    to="/car"
                    onClick={() => {
                      setBrand(b.id);
                      setModel(m.id);
                    }}
                    className="plunk flex min-h-[72px] flex-col justify-center gap-1 border border-line bg-surface px-4 text-ink no-underline [--edge:var(--color-card-edge)] [--plunk:4px]"
                  >
                    <Micro>{b.label}</Micro>
                    <span className="font-extrabold text-[15px]">{m.label} →</span>
                  </Link>
                </li>
              )),
            )}
          </ul>
        </section>

        <section id="how" className="mx-auto max-w-6xl px-5 pb-16 lg:px-8">
          <Micro>How it works</Micro>
          <h2 className="display mt-2 mb-8 text-[44px]">three steps. one minute.</h2>
          <ol className="m-0 grid list-none gap-4 p-0 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.t} className="flex flex-col gap-2 border border-line bg-surface p-5">
                <span className="font-display text-4xl text-yellow">{i + 1}</span>
                <h3 className="m-0 text-[17px]">{s.t}</h3>
                <p className="m-0 text-[14px] text-ink-2 leading-[1.55]">{s.d}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-label="Safety" className="mx-auto max-w-6xl px-5 pb-16 lg:px-8">
          <ul className="m-0 grid list-none gap-4 p-0 md:grid-cols-3">
            {SAFETY.map((s) => (
              <li key={s.t} className="flex gap-4 border border-line-faint p-5">
                <span
                  aria-hidden="true"
                  className="grid size-10 flex-none place-items-center border border-line font-extrabold text-yellow"
                >
                  {s.i}
                </span>
                <div className="flex flex-col gap-1.5">
                  <h3 className="m-0 text-[15px]">{s.t}</h3>
                  <p className="m-0 text-[13px] text-ink-2 leading-[1.55]">{s.d}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-20 lg:px-8">
          <div className="plunk flex flex-col items-start gap-5 bg-ink p-8 text-bg [--edge:var(--color-yellow)] [--plunk:10px] lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="display m-0 text-[44px]">
                see what your car
                <br />
                can unlock.
              </h2>
              <p className="mt-3 mb-0 font-semibold text-sm">Free. Takes ten seconds to check.</p>
            </div>
            <Button asChild className="lg:max-w-72">
              <Link to="/car">Find my features →</Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-line border-t px-5 py-8 text-center">
        <p className="m-0 font-extrabold text-[11px] tracking-[1.5px]">VIBECODE MY CAR · UNLOCK YOUR CAR</p>
        <p className="mt-2 mb-0 text-ink-3 text-xs">
          Not affiliated with Škoda or Volkswagen. Changes are made at your own risk.
        </p>
      </footer>
    </div>
  );
}
