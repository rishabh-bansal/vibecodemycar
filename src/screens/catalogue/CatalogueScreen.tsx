import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Shell } from '../../app/layout.tsx';
import { featureDescription, featuresFor } from '../../domain/catalog/features.ts';
import { familyFor } from '../../domain/catalog/platform.ts';
import type { FeatureItem } from '../../domain/catalog/types.ts';
import { brandLabel, modelLabel } from '../../domain/catalog/vehicles.ts';
import { familyCatalogue, withCarCopy } from '../../domain/catalogue/data.ts';
import { GROUP_LABELS } from '../../domain/catalogue/groups.ts';
import {
  applyFilters,
  chipCounts,
  codableFirst,
  type Tab,
  toSections,
} from '../../domain/catalogue/query.ts';
import { appFeatureIds, type CatalogueStatus, pickHero, statusFor } from '../../domain/catalogue/status.ts';
import type { CatalogueFeature, CatalogueModel, GroupId } from '../../domain/catalogue/types.ts';
import { useCarStore } from '../../state/car-store.ts';
import { Button } from '../../ui/Button.tsx';
import { FilterChips } from '../../ui/Chips.tsx';
import { cn } from '../../ui/cn.ts';
import { HeroPhoto } from '../../ui/HeroPhoto.tsx';
import { Logo } from '../../ui/Logo.tsx';
import { BottomNav } from '../../ui/Nav.tsx';
import { InfoCard } from '../../ui/Panels.tsx';
import {
  HeroCard,
  MultiChips,
  PhotoCard,
  PhotoRow,
  SectionHeader,
  SegmentedTabs,
  Skeleton,
} from './cards.tsx';
import { DetailContent } from './Detail.tsx';
import { nextCardIndex } from './grid-nav.ts';
import { Photo } from './Photo.tsx';
import {
  featureSearchText,
  itemSearchText,
  matchesSearch,
  parseGroups,
  serializeGroups,
  useCatalogueSearch,
} from './search.ts';
import { useCatalogue } from './useCatalogue.ts';
import { useMediaQuery } from './useMedia.ts';

const MAX_ROWS_UNDER_ALL = 3;
/** Dashboard has the best photos, so it is the grid section on mobile. */
const GRID_GROUP: GroupId = 'dashboard';

/** Everything derived from (car, user's car, filters) in one place so both layouts agree. */
function useCatalogueView(models: readonly CatalogueModel[]) {
  const { search, update } = useCatalogueSearch();
  const selection = useCarStore((s) => s.selection);

  // A car with no feature list of its own ("Other model", or a listed model without one) gets its platform
  // family's cards — what its sister cars can take, it can. No silent substitute beyond that: a car whose family
  // has no feature list gets its own screen (NoCatalogue), never Kushaq.
  const usersModel = useMemo(
    () =>
      models.find((m) => m.model === selection.model && m.make === selection.brand) ??
      familyCatalogue(models, {
        make: selection.brand,
        model: selection.model,
        title: modelLabel(selection.model),
        family: familyFor(selection),
      }),
    [models, selection],
  );
  const shownModel = models.find((m) => m.model === search.car) ?? usersModel;
  const tab: Tab = search.tab ?? 'unlocks';
  // Memoised on the URL value: a fresh array each render would defeat the `filtered` memo below.
  const groups = useMemo(() => (tab === 'service' ? [] : parseGroups(search.g)), [tab, search.g]);
  const query = search.q ?? '';
  const isUsersCar = !!shownModel && shownModel === usersModel;

  const items = useMemo(
    () => new Map<string, FeatureItem>(featuresFor(selection).map((i) => [i.id, i])),
    [selection],
  );
  const statusOf = useCallback(
    (f: CatalogueFeature): CatalogueStatus => statusFor(f, { isUsersCar, items }),
    [isUsersCar, items],
  );
  // On the user's car, each card describes the app feature this car would actually get.
  const model = useMemo(() => {
    if (!shownModel || !isUsersCar) return shownModel;
    return withCarCopy(shownModel, (f) => {
      const s = statusOf(f);
      return s.kind === 'codable' ? s.item.id : undefined;
    });
  }, [shownModel, isUsersCar, statusOf]);
  // Search text per card, built once per car: shown name, description and the setting labels it offers.
  const searchTexts = useMemo(() => {
    const texts = new Map<string, string>();
    for (const f of model?.features ?? []) {
      const s = statusOf(f);
      texts.set(f.slug, featureSearchText(f, s.kind === 'codable' ? s.item : undefined));
    }
    return texts;
  }, [model, statusOf]);
  // Codable on this car first, the rest after — each part in the catalogue's own order.
  const filtered = useMemo(() => {
    if (!model) return [];
    const matches = (f: CatalogueFeature, q: string) =>
      matchesSearch(searchTexts.get(f.slug) ?? featureSearchText(f), q);
    return codableFirst(
      applyFilters(model, { tab, groups, query }, matches),
      (f) => statusOf(f).kind === 'codable',
    );
  }, [model, tab, groups, query, searchTexts, statusOf]);
  const extraSelected = search.f && isUsersCar ? items.get(search.f) : undefined;
  const selected =
    model?.features.find((f) => f.slug === search.f) ??
    (extraSelected && extraSelected.tier !== 'unavailable' ? extraFeature(extraSelected) : undefined);
  /**
   * Codable on this car but with no catalogue entry — the curated list is narrower than what the
   * trusted pipeline can actually run. Surfaced as their own section instead of being hidden:
   * same `featuresFor` evidence the write boundary uses, never padded out with guesses.
   */
  const extras = useMemo(() => {
    if (!model || !isUsersCar) return [] as FeatureItem[];
    const joined = new Set(model.features.flatMap((f) => appFeatureIds(f.slug)));
    return [...items.values()].filter(
      (i) =>
        i.tier !== 'unavailable' &&
        !joined.has(i.id) &&
        matchesSearch(itemSearchText(i, featureDescription(i.id)), query),
    );
  }, [model, isUsersCar, items, query]);

  return {
    search,
    update,
    model,
    usersModel,
    tab,
    groups,
    query,
    isUsersCar,
    statusOf,
    filtered,
    selected,
    selection,
    extras,
  };
}
type View = ReturnType<typeof useCatalogueView> & { model: CatalogueModel };

/**
 * A detail card for a feature the app can write on this car that has no catalogue entry: its name and
 * settings come from the app data, so it opens the same detail view (settings, default, CTA) as any card.
 */
function extraFeature(item: FeatureItem): CatalogueFeature {
  return {
    slug: item.id,
    name: item.name,
    group: 'comfort',
    category: '',
    intro: featureDescription(item.id) ?? '',
    functions: [],
    requirements: [],
    attention: [],
    procedure: [],
    notes: [],
    legal: false,
  };
}

/**
 * Rows for `view.extras` — features the app can write on this car that have no catalogue card. Each row
 * opens the detail view, where the setting is picked like any other feature.
 */
function CodableExtras({ items }: { items: readonly FeatureItem[] }) {
  if (!items.length) return null;
  return (
    <section className="flex flex-col gap-2.5" aria-label="More for your car">
      <SectionHeader title="MORE FOR YOUR CAR" count={items.length} />
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              to="/features"
              search={(prev) => ({ ...prev, f: item.id })}
              className="flex flex-col gap-2 border border-line bg-surface p-3 text-ink no-underline"
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="font-bold text-sm leading-snug">{item.name}</span>
                <span className="micro [--micro-color:var(--color-green)]">{item.statusLabel}</span>
              </span>
              <span className="text-[12px] text-ink-3">
                {item.settings.map((s) => s.label).join(' · ') || 'Choose a value'} →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function useSetUpCar(model: CatalogueModel | undefined) {
  const navigate = useNavigate();
  const car = useCarStore();
  return useCallback(() => {
    if (!model) return;
    car.setBrand(model.make);
    car.setModel(model.model);
    void navigate({ to: '/car' });
  }, [car, model, navigate]);
}

function Headline({ view, count }: { view: View; count: number }) {
  const { model, tab, isUsersCar, statusOf, extras } = view;
  const unlocks = model.unlocks.length;
  const service = model.service.length;
  // The headline counts what the catalogue lists; say plainly how many of those can be coded today —
  // plus the features with no catalogue card that the trusted pipeline can still run (view.extras).
  const codable = isUsersCar
    ? model.unlocks.filter((f) => statusOf(f).kind === 'codable').length + extras.length
    : undefined;
  if (tab === 'service') {
    return <h1 className="display m-0 text-[40px] lg:text-5xl">{service} service tools.</h1>;
  }
  return (
    <div className="flex items-end justify-between gap-3">
      <h1 className="display m-0 text-[40px] lg:text-5xl">
        {unlocks} {unlocks === 1 ? 'thing' : 'things'}
        <br className="lg:hidden" /> to unlock.
      </h1>
      <span className="micro flex flex-col items-end gap-1 pb-1.5 text-right">
        {codable !== undefined && <span>{codable} available for your car</span>}
        <span>+{service} service tools</span>
      </span>
      <span className="sr-only">{count} shown</span>
    </div>
  );
}

function SearchBox({
  view,
  inputRef,
  className,
}: {
  view: View;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
}) {
  const { query, update } = view;
  const [draft, setDraft] = useState(query);
  // The last value this box committed to the URL. Only a change made elsewhere (Clear, a link) may replace
  // the draft; our own commit arriving after further typing must not overwrite the newer keystrokes.
  const committed = useRef(query);
  useEffect(() => {
    if (query !== committed.current) setDraft(query);
    committed.current = query;
  }, [query]);
  useEffect(() => {
    if (draft === query) return;
    const id = setTimeout(() => {
      committed.current = draft;
      void update({ q: draft || undefined });
    }, 150);
    return () => clearTimeout(id);
  }, [draft, query, update]);
  const clear = () => {
    setDraft('');
    committed.current = '';
    void update({ q: undefined });
    inputRef?.current?.focus();
  };
  return (
    <div role="search" className={cn('relative flex items-center', className)}>
      <Search aria-hidden="true" size={18} className="pointer-events-none absolute left-4 text-ink-3" />
      <input
        ref={inputRef}
        type="search"
        aria-label="Search features"
        placeholder="Search features, e.g. DRL or blinks"
        autoComplete="off"
        enterKeyHint="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-[50px] w-full border border-line bg-surface pr-12 pl-11 font-semibold text-[15px] text-ink outline-none placeholder:text-ink-4 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {draft && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={clear}
          className="absolute right-0 grid size-[50px] place-items-center text-ink"
        >
          <X aria-hidden="true" size={18} />
        </button>
      )}
    </div>
  );
}

function Results({ view, count }: { view: View; count: number }) {
  const { query, tab, model } = view;
  const total = tab === 'service' ? model.service.length : model.unlocks.length;
  if (!query) return null;
  return (
    <p className="m-0 font-semibold text-ink-3 text-xs" role="status">
      {count} of {total}
    </p>
  );
}

function Empty({ view }: { view: View }) {
  return (
    <div className="flex flex-col items-start gap-3 py-6">
      <p className="m-0 font-semibold text-ink-2 text-sm">nothing matches “{view.query}”.</p>
      <p className="m-0 text-ink-3 text-sm">Try another word, like “mirrors”, “lights” or “seat belt”.</p>
      <Button
        variant="secondary"
        className="w-auto"
        onClick={() => void view.update({ q: undefined, g: undefined })}
      >
        Clear
      </Button>
    </div>
  );
}

// ───────────────────────────── mobile ─────────────────────────────

function MobileList({ view }: { view: View }) {
  const { model, tab, groups, query, filtered, statusOf, update } = view;
  const chips = chipCounts(model, tab);
  const chip = groups[0] ?? 'all';
  // Mobile chips are single-select. A link from the desktop list can carry several groups: narrow it to
  // the one chip shown, so the list never shows more than the active chip says.
  useEffect(() => {
    if (groups.length > 1) void update({ g: groups[0] }, { replace: true });
  }, [groups, update]);
  const hero = tab === 'unlocks' && chip === 'all' && !query ? pickHero(model, statusOf) : undefined;
  const sections = toSections(filtered);
  const showAll = chip !== 'all' || tab === 'service' || Boolean(query);

  return (
    <div className="flex flex-1 flex-col gap-[18px] px-5 pt-6 pb-[110px]">
      <div className="flex items-center justify-between">
        <Link to="/" className="text-ink no-underline">
          <Logo collapsible className="text-base" />
        </Link>
        <div className="flex items-center gap-2.5">
          <Link
            to="/car"
            className="plunk flex min-h-11 items-center gap-2 bg-ink px-2.5 font-bold text-[11px] text-bg uppercase tracking-[1px] no-underline [--edge:var(--color-ink-4)] [--plunk:3px]"
          >
            <HeroPhoto modelKey={model.key} alt="" className="h-4 w-8 object-cover" />
            {model.model} <ChevronDown aria-hidden="true" size={12} />
          </Link>
        </div>
      </div>

      <Headline view={view} count={filtered.length} />
      {/* Always in reach: the search bar stays pinned to the top while the list scrolls under it. */}
      <div className="-mx-5 sticky top-0 z-20 flex flex-col gap-2 bg-bg px-5 py-2">
        <SearchBox view={view} />
        <Results view={view} count={filtered.length} />
      </div>

      <SegmentedTabs
        value={tab}
        onValueChange={(t) => void update({ tab: t, g: undefined })}
        options={[
          { value: 'unlocks', label: 'UNLOCKS', count: model.unlocks.length },
          { value: 'service', label: 'SERVICE TOOLS', count: model.service.length },
        ]}
      />
      {tab === 'unlocks' && (
        <FilterChips
          label="Group"
          value={chip}
          onValueChange={(v) => void update({ g: v === 'all' ? undefined : v })}
          options={[
            { value: 'all' as const, label: `ALL · ${model.unlocks.length}` },
            ...chips.map((c) => ({
              value: c.group,
              label: `${GROUP_LABELS[c.group].mobileChip} · ${c.count}`,
            })),
          ]}
        />
      )}

      {hero && <HeroCard feature={hero} />}
      {filtered.length === 0 && query && <Empty view={view} />}

      {sections.map((s) => {
        const list = showAll
          ? s.features
          : s.features.slice(0, s.group === GRID_GROUP ? 4 : MAX_ROWS_UNDER_ALL);
        const asGrid = s.group === GRID_GROUP && tab === 'unlocks';
        return (
          <section key={s.group} className="flex flex-col gap-2.5" aria-label={GROUP_LABELS[s.group].section}>
            <SectionHeader
              title={`${GROUP_LABELS[s.group].section.toUpperCase()}`}
              count={s.features.length}
              action={
                !showAll && s.features.length > list.length ? (
                  <button
                    type="button"
                    className="min-h-11 px-1 font-extrabold text-[11px] text-ink tracking-[1px]"
                    onClick={() => void update({ g: s.group })}
                  >
                    SEE ALL →
                  </button>
                ) : undefined
              }
            />
            <ul
              className={cn('m-0 list-none p-0', asGrid ? 'grid grid-cols-2 gap-3' : 'flex flex-col gap-3')}
            >
              {list.map((f) =>
                asGrid ? (
                  <PhotoCard key={f.slug} feature={f} status={statusOf(f)} />
                ) : (
                  <PhotoRow key={f.slug} feature={f} status={statusOf(f)} />
                ),
              )}
            </ul>
          </section>
        );
      })}

      {tab === 'unlocks' && <CodableExtras items={view.extras} />}

      <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[480px] lg:hidden" data-floating-nav>
        <BottomNav />
      </div>
    </div>
  );
}

function MobileDetail({ view, feature }: { view: View; feature: CatalogueFeature }) {
  const status = view.statusOf(feature);
  const setUp = useSetUpCar(view.model);
  return (
    <div className="flex flex-1 flex-col pb-4">
      <div className="relative h-[250px] flex-none">
        <Photo
          id={feature.image}
          group={feature.group}
          size="lg"
          ratio="h-full"
          eager
          className="absolute inset-0"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-b from-bg/80 via-transparent to-bg"
        />
        <div className="absolute top-[max(1rem,env(safe-area-inset-top))] left-5">
          <Link
            to="/features"
            search={(prev) => ({ ...prev, f: undefined })}
            aria-label="Back to the list"
            className="plunk grid size-11 place-items-center bg-ink font-extrabold text-bg no-underline [--edge:var(--color-ink-4)] [--plunk:3px]"
          >
            <span aria-hidden="true">←</span>
          </Link>
        </div>
        <span className="absolute top-[max(1rem,env(safe-area-inset-top))] right-5 border border-line bg-bg/70 px-2.5 py-1.5 font-extrabold text-[10px] text-ink tracking-[1.5px]">
          {GROUP_LABELS[feature.group].mobileChip}
        </span>
      </div>
      <div className="-mt-[34px] relative flex flex-1 flex-col px-5">
        <DetailContent feature={feature} status={status} onSetUpCar={setUp} cta="sticky" />
      </div>
    </div>
  );
}

// ───────────────────────────── desktop ─────────────────────────────

function Rail({ models, view }: { models: readonly CatalogueModel[]; view: View }) {
  const make = (m: 'skoda' | 'volkswagen') => models.filter((x) => x.make === m);
  return (
    <aside className="sticky top-0 hidden h-dvh w-[250px] flex-none flex-col gap-6 overflow-y-auto border-line border-r p-6 lg:flex">
      <Link to="/" className="text-ink no-underline">
        <Logo size={22} className="text-lg" />
      </Link>
      {(['skoda', 'volkswagen'] as const).map((m) => (
        <nav key={m} aria-label={brandLabel(m)} className="flex flex-col gap-2">
          <span className="micro mb-1">{brandLabel(m)}</span>
          {make(m).map((c) => {
            const on = c.model === view.model.model;
            return (
              <Link
                key={c.key}
                to="/features"
                search={(prev) => ({ ...prev, car: c.model, f: undefined, g: undefined })}
                aria-current={on ? 'true' : undefined}
                className={cn(
                  'flex min-h-11 items-center justify-between px-3.5 font-bold text-[13px] capitalize no-underline',
                  on
                    ? 'plunk bg-ink text-bg [--edge:var(--color-ink-4)] [--plunk:3px]'
                    : 'border border-line text-ink',
                )}
              >
                {c.model}
                <span className={on ? 'text-bg' : 'text-ink-4'}>{c.features.length}</span>
              </Link>
            );
          })}
        </nav>
      ))}
      <nav aria-label="App" className="mt-auto flex flex-col gap-2">
        <Link to="/car" className="micro min-h-11 content-center no-underline">
          My car
        </Link>
      </nav>
    </aside>
  );
}

function DesktopMain({
  view,
  searchRef,
}: {
  view: View;
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const { model, tab, groups, filtered, statusOf, update, selected } = view;
  const sections = toSections(filtered);
  const counts = chipCounts(model, tab);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-card]')];
    const i = cards.indexOf(document.activeElement as HTMLElement);
    if (i === -1) return;
    e.preventDefault();
    cards[
      nextCardIndex(
        cards.map((c) => c.getBoundingClientRect()),
        i,
        e.key,
      )
    ]?.focus();
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-5 p-8" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-5">
        <div className="w-[220px] flex-none">
          <HeroPhoto
            modelKey={model.key}
            alt={`${brandLabel(model.make)} ${model.title}`}
            className="aspect-[2/1] w-full object-cover"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <span className="micro">
            {brandLabel(model.make).toUpperCase()} {model.title.toUpperCase()} · {model.features.length}{' '}
            FEATURES
          </span>
          <Headline view={view} count={filtered.length} />
        </div>
      </div>
      <SearchBox view={view} inputRef={searchRef} />
      <Results view={view} count={filtered.length} />
      <SegmentedTabs
        value={tab}
        onValueChange={(t) => void update({ tab: t, g: undefined })}
        options={[
          { value: 'unlocks', label: 'UNLOCKS', count: model.unlocks.length },
          { value: 'service', label: 'SERVICE TOOLS', count: model.service.length },
        ]}
      />
      {tab === 'unlocks' && (
        <MultiChips
          value={groups}
          onChange={(g) => void update({ g: serializeGroups(g) })}
          options={counts}
        />
      )}
      {filtered.length === 0 && view.query && <Empty view={view} />}
      {sections.map((s) => (
        <section key={s.group} className="flex flex-col gap-3" aria-label={GROUP_LABELS[s.group].section}>
          <SectionHeader title={GROUP_LABELS[s.group].section.toUpperCase()} count={s.features.length} />
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-0">
            {s.features.map((f) => (
              <PhotoCard key={f.slug} feature={f} status={statusOf(f)} selected={selected?.slug === f.slug} />
            ))}
          </ul>
        </section>
      ))}
      {tab === 'unlocks' && <CodableExtras items={view.extras} />}
    </main>
  );
}

function DetailPanel({ view, feature, modal }: { view: View; feature: CatalogueFeature; modal: boolean }) {
  const setUp = useSetUpCar(view.model);
  const close = () => void view.update({ f: undefined }, { replace: false });
  const closeRef = useRef<HTMLButtonElement>(null);
  // As a dialog, focus moves into the panel when it opens (or shows another feature) and goes back to
  // whatever opened it when it closes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the shown feature changes
  useEffect(() => {
    if (!modal) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, [modal, feature.slug]);
  return (
    <>
      <button
        type="button"
        aria-label="Close details"
        tabIndex={-1}
        onClick={close}
        className="fixed inset-0 z-30 cursor-default bg-bg/80 min-[1100px]:hidden"
      />
      <aside
        aria-label={feature.name}
        {...(modal ? { role: 'dialog', 'aria-modal': true } : {})}
        className="fixed inset-y-0 right-0 z-40 flex w-[min(420px,100vw)] flex-col gap-5 overflow-y-auto border-line border-l bg-surface-2 p-6 min-[1100px]:sticky min-[1100px]:top-0 min-[1100px]:z-auto min-[1100px]:h-dvh min-[1100px]:w-[400px] min-[1100px]:flex-none"
      >
        <div className="relative">
          <Photo id={feature.image} group={feature.group} size="lg" ratio="aspect-video" eager />
          <button
            ref={closeRef}
            type="button"
            aria-label="Close details"
            onClick={close}
            className="absolute top-2 right-2 grid size-11 place-items-center bg-ink font-extrabold text-bg"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>
        <DetailContent feature={feature} status={view.statusOf(feature)} onSetUpCar={setUp} heading="h2" />
      </aside>
    </>
  );
}

function Desktop({ models, view }: { models: readonly CatalogueModel[]; view: View }) {
  const searchRef = useRef<HTMLInputElement>(null);
  const { selected, query, update } = view;
  // Below 1100 px the panel slides over the list: a modal dialog, with everything behind it inert.
  const docked = useMediaQuery('(min-width: 1100px)');
  const overlay = !!selected && !docked;

  // `/` focuses search; Esc closes the panel, then clears the search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape') {
        if (selected) void update({ f: undefined }, { replace: false });
        else if (query) void update({ q: undefined });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, query, update]);

  return (
    <div className="flex min-h-dvh">
      <div className="contents" inert={overlay || undefined}>
        <Rail models={models} view={view} />
        <DesktopMain view={view} searchRef={searchRef} />
      </div>
      {selected && <DetailPanel view={view} feature={selected} modal={!docked} />}
    </div>
  );
}

// ───────────────────────────── entry ─────────────────────────────

/** Screens 2 + 3 + desktop catalogue — the browse UI for the 8 India models. */
export function CatalogueScreen() {
  const state = useCatalogue();
  const desktop = useMediaQuery('(min-width: 1024px)');

  if (state.status === 'loading') {
    return (
      <Shell nav={false}>
        <div className="px-5 pt-6">
          <Skeleton />
        </div>
      </Shell>
    );
  }
  if (state.status === 'error') {
    return (
      <Shell nav={false}>
        <div className="flex flex-col gap-4 px-5 pt-8">
          <InfoCard title="we couldn't load the features.">Check your connection and try again.</InfoCard>
          <Button onClick={state.retry}>Try again</Button>
        </div>
      </Shell>
    );
  }
  return <Loaded models={state.models} desktop={desktop} />;
}

/** The user's car has no feature list yet. Say so, and let them browse one deliberately. */
function NoCatalogue({ models }: { models: readonly CatalogueModel[] }) {
  const selection = useCarStore((s) => s.selection);
  return (
    <Shell nav={false}>
      <div className="flex flex-col gap-5 px-5 pt-8 pb-10">
        <Link to="/" className="text-ink no-underline">
          <Logo size={22} className="text-lg" />
        </Link>
        <InfoCard
          title={`no feature list for the ${brandLabel(selection.brand)} ${modelLabel(selection.model)} yet.`}
        >
          We have feature lists for {models.length} models sold in India. You can browse one of them; nothing
          about your car changes unless you set it up.
        </InfoCard>
        {(['skoda', 'volkswagen'] as const).map((make) => (
          <nav key={make} aria-label={brandLabel(make)} className="flex flex-col gap-2">
            <span className="micro">{brandLabel(make)}</span>
            {models
              .filter((m) => m.make === make)
              .map((m) => (
                <Link
                  key={m.key}
                  to="/features"
                  search={{ car: m.model }}
                  className="flex min-h-11 items-center border border-line px-3.5 font-bold text-[13px] text-ink capitalize no-underline"
                >
                  {m.model}
                </Link>
              ))}
          </nav>
        ))}
        <Button asChild variant="secondary">
          <Link to="/car">Check my car's details</Link>
        </Button>
      </div>
    </Shell>
  );
}

function Loaded({ models, desktop }: { models: CatalogueModel[]; desktop: boolean }) {
  const view = useCatalogueView(models);
  if (!view.model) return <NoCatalogue models={models} />;
  const v = view as View;
  return (
    <Shell nav={false} wide>
      {desktop ? (
        <Desktop models={models} view={v} />
      ) : v.selected ? (
        <MobileDetail view={v} feature={v.selected} />
      ) : (
        <MobileList view={v} />
      )}
    </Shell>
  );
}
