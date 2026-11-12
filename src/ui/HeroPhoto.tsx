import { useState } from 'react';
import { heroImage } from './car-images.ts';

/**
 * A model's hero photo. Renders nothing when car images are off or the file fails to load: on
 * Cloudflare Pages a missing file is answered by the SPA fallback (HTML, status 200), which would
 * otherwise show as a broken image.
 */
export function HeroPhoto({
  modelKey,
  alt,
  className,
}: {
  modelKey: string;
  alt: string;
  className?: string;
}) {
  const src = heroImage(modelKey);
  const [failed, setFailed] = useState<string | undefined>();
  if (!src || failed === src) return null;
  return <img src={src} alt={alt} className={className} onError={() => setFailed(src)} />;
}
