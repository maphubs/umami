/**
 * eslint-disable no-console
 *
 * @format
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import https from 'https';
import tar from 'tar';
import zlib from 'zlib';

async function main() {
  if (process.env.VERCEL && !process.env.BUILD_GEO) {
    console.log('Vercel environment detected. Skipping geo setup.');
    process.exit(0);
  }

  const db = 'GeoLite2-City';

  // Support custom URL via environment variable
  let url = process.env.GEO_DATABASE_URL;
  let authCredentials = null;

  // Fallback to default URLs if not provided
  if (!url) {
    if (process.env.MAXMIND_LICENSE_KEY) {
      // MaxMind requires Basic Auth with Account ID and License Key
      // See: https://dev.maxmind.com/geoip/updating-databases/#directly-downloading-databases
      const accountId = process.env.MAXMIND_ACCOUNT_ID;
      const licenseKey = process.env.MAXMIND_LICENSE_KEY;

      if (!accountId) {
        console.error('MAXMIND_ACCOUNT_ID is required when using MAXMIND_LICENSE_KEY');
        console.error(
          'Get your Account ID from: https://www.maxmind.com/en/accounts/current/account',
        );
        process.exit(1);
      }

      // Use the permalink format from MaxMind account portal
      // Format: https://download.maxmind.com/geoip/databases/{DATABASE}/download?suffix=tar.gz
      // Requires Basic Auth with AccountID:LicenseKey
      url = `https://download.maxmind.com/geoip/databases/${db}/download?suffix=tar.gz`;
      authCredentials = `${accountId}:${licenseKey}`;
      console.log('Using MaxMind official download with Basic Auth');
      console.log(`Downloading from: ${url}`);
    } else {
      url = `https://raw.githubusercontent.com/GitSquared/node-geolite2-redist/master/redist/${db}.tar.gz`;
      console.log('Using fallback GeoLite2 database from GitHub');
      console.log(
        'Note: For production, set MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY for official MaxMind database',
      );
    }
  }

  const dest = path.resolve(process.cwd(), 'geo');

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  // Check if URL points to a direct .mmdb file (already extracted)
  const isDirectMmdb = url.endsWith('.mmdb');

  // Download handler for compressed tar.gz files
  const downloadCompressed = (downloadUrl, credentials) =>
    new Promise((resolve, reject) => {
      const urlObj = new URL(downloadUrl);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {},
      };

      // Add Basic Authentication if credentials provided
      if (credentials) {
        const auth = Buffer.from(credentials).toString('base64');
        options.headers.Authorization = `Basic ${auth}`;
      }

      // Follow redirects (MaxMind uses R2 presigned URLs)
      // Important: Only send auth headers to the initial MaxMind URL, not to redirect URLs
      const makeRequest = (currentUrl, isRedirect = false) => {
        const currentUrlObj = new URL(currentUrl);
        const currentOptions = {
          hostname: currentUrlObj.hostname,
          path: currentUrlObj.pathname + currentUrlObj.search,
          method: 'GET',
          headers: {},
        };

        // Only add auth headers for the initial request, not for redirects
        // R2 presigned URLs don't need/accept auth headers
        if (!isRedirect && credentials) {
          const auth = Buffer.from(credentials).toString('base64');
          currentOptions.headers.Authorization = `Basic ${auth}`;
        }

        https
          .get(currentOptions, res => {
            // Handle redirects (301, 302, 307, 308)
            if (
              res.statusCode === 301 ||
              res.statusCode === 302 ||
              res.statusCode === 307 ||
              res.statusCode === 308
            ) {
              const redirectUrl = res.headers.location;
              if (!redirectUrl) {
                reject(new Error(`Redirect received but no location header: ${res.statusCode}`));
                return;
              }
              // Follow redirect without auth headers
              makeRequest(redirectUrl, true);
              return;
            }

            if (res.statusCode !== 200) {
              // Read error response body for debugging
              let errorBody = '';
              res.on('data', chunk => {
                errorBody += chunk.toString();
              });
              res.on('end', () => {
                reject(
                  new Error(
                    `HTTP ${res.statusCode}: ${res.statusMessage}${
                      errorBody ? ` - ${errorBody}` : ''
                    }`,
                  ),
                );
              });
              return;
            }
            resolve(res.pipe(zlib.createGunzip({})).pipe(tar.t()));
          })
          .on('error', reject);
      };

      makeRequest(downloadUrl);
    });

  // Download handler for direct .mmdb files
  const downloadDirect = (downloadUrl, originalUrl, credentials) =>
    new Promise((resolve, reject) => {
      // Important: Only send auth headers to the initial MaxMind URL, not to redirect URLs
      const makeRequest = (currentUrl, isRedirect = false) => {
        const urlObj = new URL(currentUrl);
        const options = {
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers: {},
        };

        // Only add auth headers for the initial request, not for redirects
        // R2 presigned URLs don't need/accept auth headers
        if (!isRedirect && credentials) {
          const auth = Buffer.from(credentials).toString('base64');
          options.headers.Authorization = `Basic ${auth}`;
        }

        https
          .get(options, res => {
            // Follow redirects (301, 302, 307, 308)
            if (
              res.statusCode === 301 ||
              res.statusCode === 302 ||
              res.statusCode === 307 ||
              res.statusCode === 308
            ) {
              const redirectUrl = res.headers.location;
              if (!redirectUrl) {
                reject(new Error(`Redirect received but no location header: ${res.statusCode}`));
                return;
              }
              // Follow redirect without auth headers
              makeRequest(redirectUrl, true);
              return;
            }

            if (res.statusCode !== 200) {
              // Read error response body for debugging
              let errorBody = '';
              res.on('data', chunk => {
                errorBody += chunk.toString();
              });
              res.on('end', () => {
                reject(
                  new Error(
                    `HTTP ${res.statusCode}: ${res.statusMessage}${
                      errorBody ? ` - ${errorBody}` : ''
                    }`,
                  ),
                );
              });
              return;
            }

            const filename = path.join(dest, path.basename(originalUrl || currentUrl));
            const fileStream = fs.createWriteStream(filename);

            res.pipe(fileStream);

            fileStream.on('finish', () => {
              fileStream.close();
              console.log('Saved geo database:', filename);
              // Verify file exists and has content
              const stats = fs.statSync(filename);
              if (stats.size === 0) {
                reject(new Error('Downloaded file is empty'));
                return;
              }
              resolve();
            });

            fileStream.on('error', e => {
              reject(e);
            });
          })
          .on('error', reject);
      };

      makeRequest(downloadUrl);
    });

  try {
    // Execute download based on file type
    if (isDirectMmdb) {
      await downloadDirect(url, url, authCredentials);
    } else {
      const tarStream = await downloadCompressed(url, authCredentials);
      await new Promise((resolve, reject) => {
        let foundFile = false;
        tarStream.on('entry', entry => {
          if (entry.path.endsWith('.mmdb')) {
            foundFile = true;
            const filename = path.join(dest, path.basename(entry.path));
            const fileStream = fs.createWriteStream(filename);
            entry.pipe(fileStream);

            fileStream.on('finish', () => {
              fileStream.close();
              console.log('Saved geo database:', filename);
              // Verify file exists and has content
              const stats = fs.statSync(filename);
              if (stats.size === 0) {
                reject(new Error('Downloaded file is empty'));
                return;
              }
            });

            fileStream.on('error', reject);
          }
        });

        tarStream.on('error', reject);
        tarStream.on('end', () => {
          if (!foundFile) {
            reject(new Error('No .mmdb file found in archive'));
            return;
          }
          resolve();
        });
      });
    }

    // Verify the file was created
    const expectedFile = path.join(dest, 'GeoLite2-City.mmdb');
    if (!fs.existsSync(expectedFile)) {
      throw new Error(`Geo database file not found at ${expectedFile}`);
    }

    const stats = fs.statSync(expectedFile);
    console.log(
      `Geo database ready: ${expectedFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`,
    );
    process.exit(0);
  } catch (e) {
    console.error('Failed to download geo database:', e);
    process.exit(1);
  }
}

main();
