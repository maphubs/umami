/** @format */

import fs from 'node:fs/promises';
import path from 'node:path';
import { browserName, detectOS } from 'detect-browser';
import ipaddr from 'ipaddr.js';
import isLocalhost from 'is-localhost-ip';
import maxmind from 'maxmind';
import { UAParser } from 'ua-parser-js';
import { getIpAddress, stripPort } from '@/lib/ip';
import { safeDecodeURIComponent } from '@/lib/url';

const MAXMIND = 'maxmind';

const PROVIDER_HEADERS = [
  // Cloudflare headers
  {
    countryHeader: 'cf-ipcountry',
    regionHeader: 'cf-region-code',
    cityHeader: 'cf-ipcity',
  },
  // Vercel headers
  {
    countryHeader: 'x-vercel-ip-country',
    regionHeader: 'x-vercel-ip-country-region',
    cityHeader: 'x-vercel-ip-city',
  },
  // CloudFront headers
  {
    countryHeader: 'cloudfront-viewer-country',
    regionHeader: 'cloudfront-viewer-country-region',
    cityHeader: 'cloudfront-viewer-city',
  },
];

export function getDevice(userAgent: string, screen: string = '') {
  const { device } = UAParser(userAgent);

  const [width] = screen.split('x');

  const type = device?.type || 'desktop';

  if (type === 'desktop' && screen && +width <= 1920) {
    return 'laptop';
  }

  return type;
}

function getRegionCode(country: string, region: string) {
  if (!country || !region) {
    return undefined;
  }

  return region.includes('-') ? region : `${country}-${region}`;
}

function decodeHeader(s: string | undefined | null): string | undefined | null {
  if (s === undefined || s === null) {
    return s;
  }

  return Buffer.from(s, 'latin1').toString('utf-8');
}

export async function getLocation(ip: string = '', headers: Headers, hasPayloadIP: boolean) {
  // Ignore local ips
  if (!ip || (await isLocalhost(ip))) {
    if (process.env.DEBUG_GEO) {
      // eslint-disable-next-line no-console
      console.log(`[GEO] Skipping localhost IP: ${ip}`);
    }
    return null;
  }

  if (process.env.DEBUG_GEO) {
    // eslint-disable-next-line no-console
    console.log(`[GEO] Looking up location for IP: ${ip}`);
  }

  if (!hasPayloadIP && !process.env.SKIP_LOCATION_HEADERS) {
    for (const provider of PROVIDER_HEADERS) {
      const countryHeader = headers.get(provider.countryHeader);
      if (countryHeader) {
        const country = decodeHeader(countryHeader);
        const region = decodeHeader(headers.get(provider.regionHeader));
        const city = decodeHeader(headers.get(provider.cityHeader));

        if (process.env.DEBUG_GEO) {
          // eslint-disable-next-line no-console
          console.log(
            `[GEO] Found location from ${provider.countryHeader}: ${country}, ${region}, ${city}`,
          );
        }

        return {
          country,
          region: getRegionCode(country, region),
          city,
        };
      }
    }
  }

  // Database lookup
  if (!globalThis[MAXMIND]) {
    try {
      const dir = path.join(process.cwd(), 'geo');
      const dbPath = process.env.GEOLITE_DB_PATH || path.resolve(dir, 'GeoLite2-City.mmdb');

      if (process.env.DEBUG_GEO) {
        // eslint-disable-next-line no-console
        console.log(`[GEO] Opening database at: ${dbPath}`);
      }

      // Check if file exists
      try {
        await fs.access(dbPath);
      } catch {
        // eslint-disable-next-line no-console
        console.error(`GeoLite2 database file not found at: ${dbPath}`);
        return null;
      }

      globalThis[MAXMIND] = await maxmind.open(dbPath);
      if (process.env.DEBUG_GEO) {
        // eslint-disable-next-line no-console
        console.log(`[GEO] Database opened successfully`);
      }
    } catch (error) {
      // Database file not found or cannot be opened
      // eslint-disable-next-line no-console
      console.error('Failed to open GeoLite2 database:', error);
      return null;
    }
  }

  const strippedIp = stripPort(ip);
  const result = globalThis[MAXMIND]?.get(strippedIp);

  if (process.env.DEBUG_GEO) {
    // eslint-disable-next-line no-console
    console.log(`[GEO] Database lookup for ${strippedIp}: ${result ? 'found' : 'not found'}`);
  }

  if (result) {
    const country = result.country?.iso_code ?? result?.registered_country?.iso_code;
    const region = result.subdivisions?.[0]?.iso_code;
    const city = result.city?.names?.en;

    if (process.env.DEBUG_GEO) {
      // eslint-disable-next-line no-console
      console.log(`[GEO] Result: country=${country}, region=${region}, city=${city}`);
    }

    return {
      country,
      region: getRegionCode(country, region),
      city,
    };
  }

  // Return null explicitly if no result found
  if (process.env.DEBUG_GEO) {
    // eslint-disable-next-line no-console
    console.log(`[GEO] No location data found for IP: ${ip}`);
  }
  return null;
}

export async function getClientInfo(request: Request, payload: Record<string, any>) {
  const userAgent = payload?.userAgent || request.headers.get('user-agent');
  const ip = payload?.ip || getIpAddress(request.headers);

  if (process.env.DEBUG_GEO) {
    // eslint-disable-next-line no-console
    console.log(`[GEO] getClientInfo - IP: ${ip}, hasPayloadIP: ${!!payload?.ip}`);
  }

  const location = await getLocation(ip, request.headers, !!payload?.ip);
  const country = safeDecodeURIComponent(location?.country) || undefined;
  const region = safeDecodeURIComponent(location?.region) || undefined;
  const city = safeDecodeURIComponent(location?.city) || undefined;

  if (process.env.DEBUG_GEO) {
    // eslint-disable-next-line no-console
    console.log(`[GEO] Final result - country: ${country}, region: ${region}, city: ${city}`);
  }

  const browser = payload?.browser ?? browserName(userAgent);
  const os = payload?.os ?? (detectOS(userAgent) as string);
  const device = payload?.device ?? getDevice(userAgent, payload?.screen);

  return { userAgent, browser, os, ip, country, region, city, device };
}

export function hasBlockedIp(clientIp: string) {
  const ignoreIps = process.env.IGNORE_IP;

  if (ignoreIps) {
    const ips = [];

    if (ignoreIps) {
      ips.push(...ignoreIps.split(',').map(n => n.trim()));
    }

    return ips.find(ip => {
      if (ip === clientIp) {
        return true;
      }

      // CIDR notation
      if (ip.indexOf('/') > 0) {
        const addr = ipaddr.parse(clientIp);
        const range = ipaddr.parseCIDR(ip);

        if (addr.kind() === range[0].kind() && addr.match(range)) {
          return true;
        }
      }

      return false;
    });
  }

  return false;
}
