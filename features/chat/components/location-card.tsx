import { MapPin } from 'lucide-react';
import * as React from 'react';

/**
 * A shared location.
 *
 * Deliberately not an embedded map: a tile provider would see the coordinates
 * of every location either person ever shares, and an iframe would punch a hole
 * in the strict CSP for the sake of a thumbnail. The card shows the coordinates
 * and hands off to whatever map app the device already has.
 */
export function LocationCard({
  location,
}: {
  location: { lat: number; lng: number; label: string | null };
}): React.JSX.Element {
  const coordinates = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
  // `geo:` opens the native app on mobile; the query parameter is what desktop
  // browsers and most map apps read as the pin.
  const href = `geo:${location.lat},${location.lng}?q=${location.lat},${location.lng}`;

  return (
    <a
      href={href}
      // A location is user-supplied content leaving the app: never give the
      // opened context a handle back to this window.
      rel="noopener noreferrer"
      target="_blank"
      className="flex items-center gap-3 rounded-[var(--radius-md)] bg-current/10 px-3 py-2 transition-opacity hover:opacity-85"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-current/15">
        <MapPin className="size-4" aria-hidden />
      </span>

      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">
          {location.label ?? 'Shared location'}
        </span>
        <span className="block truncate text-xs opacity-70">{coordinates}</span>
      </span>
    </a>
  );
}
