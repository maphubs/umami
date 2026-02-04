/** @format */

export const IP_ADDRESS_HEADERS = [
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
    return ip;
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
    // Check if it's a private IP (10.x.x.x, 172.16-31.x.x, 192.168.x.x, 127.x.x.x, etc.)
    const isPrivate =
      extractedIp.startsWith('10.') ||
      extractedIp.startsWith('172.16.') ||
      extractedIp.startsWith('172.17.') ||
      extractedIp.startsWith('172.18.') ||
      extractedIp.startsWith('172.19.') ||
      extractedIp.startsWith('172.20.') ||
      extractedIp.startsWith('172.21.') ||
      extractedIp.startsWith('172.22.') ||
      extractedIp.startsWith('172.23.') ||
      extractedIp.startsWith('172.24.') ||
      extractedIp.startsWith('172.25.') ||
      extractedIp.startsWith('172.26.') ||
      extractedIp.startsWith('172.27.') ||
      extractedIp.startsWith('172.28.') ||
      extractedIp.startsWith('172.29.') ||
      extractedIp.startsWith('172.30.') ||
      extractedIp.startsWith('172.31.') ||
      extractedIp.startsWith('192.168.') ||
      extractedIp.startsWith('127.') ||
      extractedIp === '::1' ||
      extractedIp.startsWith('169.254.'); // Link-local

    if (isPrivate) {
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

  return selectedIp || null;
}

export function stripPort(ip: string) {
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
