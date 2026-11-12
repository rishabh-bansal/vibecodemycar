import data from '../data/catalogue.json' with { type: 'json' };

export interface CodingFeature { id: string; name: string; category: string; source: string }
export interface CodingBuild { id: string; brand: string; model: string; variant: string; name: string; source: string; hardware: Record<string, string>; features: string[] }
export const CATALOGUE = data as unknown as { retrievedAt: string; source: string; processSource: string; notice: string; features: CodingFeature[]; builds: CodingBuild[]; pagesRead: number };

export function buildsFor(make: string, model: string): CodingBuild[] {
  const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  return CATALOGUE.builds.filter(b => normalize(b.brand) === normalize(make) && normalize(b.model) === normalize(model));
}

export function featuresFor(buildId: string): CodingFeature[] {
  const build = CATALOGUE.builds.find(b => b.id === buildId);
  return build ? CATALOGUE.features.filter(f => build.features.includes(f.id)) : [];
}

export function compatibility(build: CodingBuild, car: { make: string; model: string; buildMonth: string }): string[] {
  const reasons: string[] = [];
  if (!buildsFor(car.make, car.model).some(b => b.id === build.id)) reasons.push('This listing is for a different vehicle model.');
  const era = build.hardware.Manufactured?.toLowerCase() ?? '';
  if (!car.buildMonth) reasons.push('Enter the manufacture month in Garage and check the fitted equipment.');
  else {
    if (era.includes('before') && car.buildMonth >= '2024-04') reasons.push('The listed build predates April 2024.');
    if (era.includes('post') && car.buildMonth <= '2024-04') reasons.push('The listed build is after April 2024.');
    if (!era.includes('before') && !era.includes('post') && era.includes('april 2024') && car.buildMonth !== '2024-04') reasons.push('The listed build was manufactured during April 2024.');
  }
  return reasons;
}
