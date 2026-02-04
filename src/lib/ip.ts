import ipaddr from 'ipaddr.js';

export const IP_ADDRESS_HEADERS = [
  ...(process.env.CLOUD_MODE ? ['x-umami-client-ip'] : []), // Umami custom header (cloud mode only)
  'true-client-ip', // CDN
  'cf-connecting-ip', // Cloudflare
  'fastly-client-ip', // Fastly
  'x-nf-client-connection-ip', // Netlify
  'do-connecting-ip', // Digital Ocean
  'x-forwarded-for', // Most common - check before x-real-ip (which may contain internal IP)
  'x-appengine-user-ip', // Google App Engine
  'x-real-ip', // Reverse proxy / Nginx (may contain internal IP, so check after x-forwarded-for)
  'forwarded',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-forwarded',
  'x-original-forwarded-for', // Some proxies
];

/**
 * Normalize IP strings to a canonical form:
 * - strips IPv4-mapped IPv6 (e.g. ::ffff:192.0.2.1 -> 192.0.2.1)
 * - keeps valid IPv4/IPv6 as-is (canonically formatted by ipaddr.js)
 */
function normalizeIp(ip?: string | null) {
  if (!ip) return ip;

  try {
    const parsed = ipaddr.parse(ip);

    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      return (parsed as ipaddr.IPv6).toIPv4Address().toString();
    }

    return parsed.toString();
  } catch {
    // Fallback: return original if parsing fails
    return ip;
  }
}

function resolveIp(ip?: string | null) {
  if (!ip) return ip;

  // First, try as-is
  const normalized = normalizeIp(ip);
  try {
    ipaddr.parse(normalized);
    return normalized;
  } catch {
    // try stripping port (handles IPv4:port; leaves IPv6 intact)
    const stripped = stripPort(ip);
    if (stripped !== ip) {
      const normalizedStripped = normalizeIp(stripped);
      try {
        ipaddr.parse(normalizedStripped);
        return normalizedStripped;
      } catch {
        return normalizedStripped;
      }
    }

    return normalized;
  }
}

/**
 * Detect private/internal IPs that should not be treated as the real client IP
 * (RFC1918 ranges, loopback, link-local).
 */
function isPrivateIp(ip: string) {
  return (
    ip.startsWith('10.') ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip) ||
    ip.startsWith('192.168.') ||
    ip.startsWith('127.') ||
    ip === '::1' ||
    ip.startsWith('169.254.') // Link-local
  );
}

export function getIpAddress(headers: Headers) {
  const customHeader = process.env.CLIENT_IP_HEADER;

  if (customHeader && headers.get(customHeader)) {
    let ip = headers.get(customHeader);

    // If it's x-forwarded-for or forwarded header, extract the first IP
    if (customHeader === 'x-forwarded-for' && ip) {
      ip = ip.split(',')?.[0]?.trim() || ip;
    } else if (customHeader === 'forwarded' && ip) {
      const match = ip.match(/for=(\[?[0-9a-fA-F:.]+\]?)/);
      if (match) {
        ip = match[1];
      }
    }

    if (process.env.DEBUG_GEO) {
      // eslint-disable-next-line no-console
      console.log(`[IP] Using custom header ${customHeader}: ${ip}`);
    }

    return resolveIp(ip);
  }

  // Debug: log all available IP-related headers
  if (process.env.DEBUG_GEO) {
    const availableHeaders: string[] = [];
    IP_ADDRESS_HEADERS.forEach(name => {
      const value = headers.get(name);
      if (value) {
        availableHeaders.push(`${name}=${value}`);
      }
    });
    // eslint-disable-next-line no-console
    console.log(`[IP] Available IP headers: ${availableHeaders.join(', ') || 'none'}`);
  }

  // Check headers in order, but skip private/internal IPs
  let selectedHeader: string | undefined;
  let selectedIp: string | null | undefined;

  for (const name of IP_ADDRESS_HEADERS) {
    const value = headers.get(name);
    if (!value) continue;

    let extractedIp: string | null | undefined = value;

    // Extract IP from x-forwarded-for (first IP in comma-separated list)
    if (name === 'x-forwarded-for') {
      extractedIp = value.split(',')?.[0]?.trim();
    }

    // Extract IP from forwarded header
    if (name === 'forwarded') {
      const match = value.match(/for=(\[?[0-9a-fA-F:.]+\]?)/);
      if (match) {
        extractedIp = match[1];
      }
    }

    if (!extractedIp) continue;

    // Skip private/internal IPs - they're not the real client IP
    if (isPrivateIp(extractedIp)) {
      if (process.env.DEBUG_GEO) {
        // eslint-disable-next-line no-console
        console.log(`[IP] Skipping private IP from ${name}: ${extractedIp}`);
      }
      continue; // Try next header
    }

    // Found a valid public IP
    selectedHeader = name;
    selectedIp = extractedIp;
    break;
  }

  if (process.env.DEBUG_GEO) {
    if (selectedHeader) {
      // eslint-disable-next-line no-console
      console.log(`[IP] Using header ${selectedHeader}: ${selectedIp}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[IP] No valid public IP address found in any header`);
    }
  }

  return selectedIp ? resolveIp(selectedIp) : null;
}

export function stripPort(ip?: string | null) {
  if (!ip) {
    return ip;
  }

  if (ip.startsWith('[')) {
    const endBracket = ip.indexOf(']');
    if (endBracket !== -1) {
      return ip.slice(0, endBracket + 1);
    }
  }

  const idx = ip.lastIndexOf(':');
  if (idx !== -1) {
    if (ip.includes('.') || /^[a-zA-Z0-9.-]+$/.test(ip.slice(0, idx))) {
      return ip.slice(0, idx);
    }
  }

  return ip;
}
