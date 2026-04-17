/**
 * Discovery cache refresh — fetches OIDC well-known documents and caches
 * them in the deployment cache directory. Cached standard fields override
 * static discovery files at load time (via mergeDiscoveryData).
 *
 * Well-known URL resolution order:
 *   1. _well_known_url string → use directly
 *   2. _well_known_url === false → skip (previously failed)
 *   3. absent → derive from issuer: {issuer}/.well-known/openid-configuration
 *
 * After fetch, backfills _well_known_url into the static file:
 *   - success → confirmed URL string
 *   - failure → false (avoids retrying on future runs)
 */
import fs from 'fs';
import path from 'path';

import type { DiscoveryFile } from './discovery-loader.js';
import { logger } from '../logger.js';

const PLACEHOLDER_RE = /\{(\w+)\}/;
const FETCH_TIMEOUT_MS = 5_000;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Resolve the well-known URL for a discovery file.
 * Returns the URL string, or null if the provider should be skipped.
 */
function resolveWellKnownUrl(data: DiscoveryFile): string | null {
  // Explicit false → skip (previously failed)
  if (data._well_known_url === false) return null;

  // Explicit string → use it
  if (typeof data._well_known_url === 'string') {
    const url = data._well_known_url;
    // Skip templated URLs
    if (PLACEHOLDER_RE.test(url)) return null;
    return url;
  }

  // Derive from issuer
  const issuer = data.issuer as string | undefined;
  if (!issuer || typeof issuer !== 'string') return null;
  if (PLACEHOLDER_RE.test(issuer)) return null;

  // Strip trailing slash before appending path
  return `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
}

/**
 * Check if a cached file is still fresh based on mtime.
 */
function isFresh(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs < STALE_THRESHOLD_MS;
  } catch {
    return false;
  }
}

/**
 * Filter a fetched discovery document to standard fields only.
 * Drops any _* custom fields that may appear in the upstream response.
 */
function filterStandardFields(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('_')) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Backfill _well_known_url into a static discovery JSON file.
 * Reads the file, adds/updates the field, writes it back with stable formatting.
 */
function backfillWellKnownUrl(
  staticFilePath: string,
  value: string | false,
): void {
  try {
    const content = fs.readFileSync(staticFilePath, 'utf-8');
    const data = JSON.parse(content);
    data._well_known_url = value;
    fs.writeFileSync(staticFilePath, JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    logger.debug(
      { err, path: staticFilePath },
      'Discovery refresh: could not backfill _well_known_url',
    );
  }
}

export interface RefreshResult {
  fetched: number;
  skipped: number;
  failed: number;
}

/**
 * Refresh the discovery cache by fetching well-known URLs.
 *
 * For each static discovery file:
 * - Resolves the well-known URL (explicit, derived from issuer, or skip)
 * - Skips if cached file is still fresh (mtime < 24h)
 * - Fetches the document, filters to standard fields, writes to cache
 * - Backfills _well_known_url into the static file on first success/failure
 *
 * TODO: Updated cached files are only picked up on next full restart because
 * intercept rules are built once at startup (loadDiscoveryProviders →
 * registerDiscoveryProviders). To apply refreshed endpoints at runtime we
 * need partial rule reloading in the credential proxy — must be designed
 * carefully to avoid interfering with in-flight proxy operations (active
 * connections, pending token exchanges, etc.).
 */
export async function refreshDiscoveryCache(
  staticDir: string,
  cacheDir: string,
): Promise<RefreshResult> {
  const result: RefreshResult = { fetched: 0, skipped: 0, failed: 0 };

  // Ensure cache directory exists
  fs.mkdirSync(cacheDir, { recursive: true });

  let files: string[];
  try {
    files = fs.readdirSync(staticDir).filter((f) => f.endsWith('.json'));
  } catch {
    return result;
  }

  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    const staticFilePath = path.join(staticDir, file);
    const cacheFilePath = path.join(cacheDir, file);

    let data: DiscoveryFile;
    try {
      data = JSON.parse(
        fs.readFileSync(staticFilePath, 'utf-8'),
      ) as DiscoveryFile;
    } catch {
      result.skipped++;
      continue;
    }

    const url = resolveWellKnownUrl(data);
    if (!url) {
      result.skipped++;
      continue;
    }

    // Skip if cached file is still fresh
    if (isFresh(cacheFilePath)) {
      result.skipped++;
      continue;
    }

    const needsBackfill = data._well_known_url === undefined;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = (await response.json()) as Record<string, unknown>;
      const filtered = filterStandardFields(body);

      fs.writeFileSync(cacheFilePath, JSON.stringify(filtered, null, 2) + '\n');
      result.fetched++;

      if (needsBackfill) {
        backfillWellKnownUrl(staticFilePath, url);
      }

      logger.debug({ id, url }, 'Discovery refresh: fetched');
    } catch (err) {
      result.failed++;

      if (needsBackfill) {
        backfillWellKnownUrl(staticFilePath, false);
      }

      logger.debug(
        { id, url, err: err instanceof Error ? err.message : err },
        'Discovery refresh: fetch failed',
      );
    }
  }

  logger.info(
    {
      fetched: result.fetched,
      skipped: result.skipped,
      failed: result.failed,
    },
    'Discovery refresh complete',
  );

  return result;
}
