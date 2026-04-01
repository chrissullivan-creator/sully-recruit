/**
 * Geocoding utilities for location/radius search.
 * Uses the free Nominatim (OpenStreetMap) geocoding API.
 */

export interface GeoCoordinates {
  lat: number;
  lng: number;
  displayName: string;
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

/**
 * Geocode a location string to lat/lng coordinates using Nominatim.
 */
export async function geocodeLocation(query: string): Promise<GeoCoordinates | null> {
  if (!query.trim()) return null;
  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      limit: '1',
      addressdetails: '0',
    });
    const resp = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': 'SullyRecruit/1.0' },
    });
    if (!resp.ok) return null;
    const results = await resp.json();
    if (!results.length) return null;
    return {
      lat: parseFloat(results[0].lat),
      lng: parseFloat(results[0].lon),
      displayName: results[0].display_name,
    };
  } catch {
    return null;
  }
}

/**
 * Calculate distance in miles between two lat/lng coordinates
 * using the Haversine formula.
 */
export function haversineDistanceMiles(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 3958.8; // Earth's radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
