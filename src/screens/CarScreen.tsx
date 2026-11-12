import { Link } from '@tanstack/react-router';
import { useFeatures } from '../app/hooks.ts';
import { Shell, useCarImage } from '../app/layout.tsx';
import { unlockableCount } from '../domain/catalog/features.ts';
import { familyModelNames, familyOf, isOtherModel } from '../domain/catalog/platform.ts';
import type { CarSelection } from '../domain/catalog/types.ts';
import { BRAND_OPTIONS, brandLabel, modelChoicesFor } from '../domain/catalog/vehicles.ts';
import { useCarStore } from '../state/car-store.ts';
import { Button } from '../ui/Button.tsx';
import { CarHero, ModelCards } from '../ui/CarHero.tsx';
import { ChoiceGroup } from '../ui/Choice.tsx';
import { modelImage } from '../ui/car-images.ts';

import { Logo } from '../ui/Logo.tsx';

/** What the connected car already reported, in plain words; empty before the first connection. */
function detectedLine(
  detected: { modelYear?: number; cluster?: 'analogue' | 'digital' } | undefined,
): string {
  return [
    detected?.modelYear ? `${detected.modelYear} model year` : undefined,
    detected?.cluster ? `${detected.cluster} instrument cluster` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * For "Other model": which sister cars its features come from, and whether the car has confirmed it. Empty for a
 * listed model.
 */
function familyLine(sel: CarSelection): string {
  if (!isOtherModel(sel.model)) return '';
  const { family, confirmed } = familyOf(sel);
  const sisters = familyModelNames(family);
  if (confirmed)
    return `Your car is built on the same platform as the ${sisters}, so it gets their features.`;
  if (sel.detected)
    return `We couldn't tell your car's platform from what it reported, so we're showing what the ${sisters} share — most Škoda and Volkswagen cars sold in India are built on it.`;
  return `Showing what the ${sisters} share — most Škoda and Volkswagen cars sold in India are built on this platform. We'll confirm yours when you connect.`;
}

/**
 * Screen 1 · Your car. Brand, then model — the same two questions for every car; "Other model" covers any car not
 * listed, its features coming from its platform family (read from the car on connect). Year, trim and instrument cluster are read from the car when it connects, never asked; the VIN is
 * read on connect, never typed.
 */
export function CarScreen() {
  const car = useCarStore();
  const { selection: sel } = car;
  const image = useCarImage();
  const features = useFeatures();
  const models = modelChoicesFor(sel.brand);
  const modelLabel = models.find((m) => m.id === sel.model)?.label ?? '';
  const other = isOtherModel(sel.model);
  const carName = other ? `${brandLabel(sel.brand)} (other model)` : `${brandLabel(sel.brand)} ${modelLabel}`;
  const detected = detectedLine(sel.detected);
  const family = familyLine(sel);

  return (
    <Shell>
      <div className="flex flex-1 flex-col px-5 pt-4 lg:pt-0">
        <div className="flex items-center justify-between lg:hidden">
          <Link to="/" className="text-ink no-underline">
            <Logo className="text-base" />
          </Link>
          <span className="bg-green px-2.5 py-1.5 font-extrabold text-[11px] text-bg tracking-[1.5px]">
            FREE
          </span>
        </div>

        <h1 className="display mt-3 mb-0 text-[30px] leading-[1.05] lg:text-5xl">
          which car are
          <br />
          we unlocking?
        </h1>

        <CarHero
          className="mt-3"
          label={carName.toUpperCase()}
          count={unlockableCount(features)}
          image={image}
          alt={carName}
        />

        <form className="mt-2.5 flex flex-col gap-2" onSubmit={(e) => e.preventDefault()}>
          <ChoiceGroup
            label="Brand"
            className="grid-cols-2"
            value={sel.brand}
            onValueChange={(v) => car.setBrand(v as typeof sel.brand)}
            options={BRAND_OPTIONS.map((b) => ({ value: b.id, label: b.label }))}
          />
          {/* The car pictures say "model"; the cards are labelled for screen readers by the group itself. */}
          <ModelCards
            models={models.map((m) => ({ ...m, image: modelImage(sel.brand, m.id) }))}
            value={sel.model}
            onValueChange={car.setModel}
          />
        </form>

        <section
          aria-label="Read from your car"
          className="mt-3 flex flex-col gap-0.5 border border-line bg-surface px-3 py-2"
        >
          <span className="micro">Read from your car</span>
          <p className="m-0 font-semibold text-ink-2 text-xs leading-[1.45]">
            {detected
              ? `Your ${other ? 'car' : modelLabel}: ${detected}.`
              : 'Year, trim and instrument cluster come from your car when you connect. Nothing to look up.'}
          </p>
          {family && <p className="m-0 text-ink-2 text-xs leading-[1.45]">{family}</p>}
        </section>

        {/* Pinned to the bottom of the screen, so "See features" is always in view without scrolling. */}
        <div className="sticky bottom-0 -mx-5 mt-auto bg-bg px-5 pt-2.5 pb-[max(12px,env(safe-area-inset-bottom))] lg:static lg:mx-0 lg:mt-8 lg:px-0">
          <Button asChild>
            <Link to="/features">See features →</Link>
          </Button>
        </div>
      </div>
    </Shell>
  );
}
