import {createBaseDuckDbConnector} from '@sqlrooms/duckdb';
import type {DuckDbConnector} from '@sqlrooms/duckdb';
import {tableFromArrays, tableFromIPC} from 'apache-arrow';
import type {Table, TypeMap} from 'apache-arrow';

const ARROW_STREAM_MIME = 'application/vnd.apache.arrow.stream';
const ARROW_FILE_MIME = 'application/vnd.apache.arrow.file';
const OCTET_STREAM_MIME = 'application/octet-stream';
const QUERY_ATTEMPTS = 2;
const QUERY_RETRY_DELAY_MS = 150;

export function getRServerUrlFromLocation(): string | null {
  if (typeof window === 'undefined') return null;

  const url = new URL(window.location.href);
  const rPort = url.searchParams.get('r_port');
  if (!rPort) return null;

  const host = url.searchParams.get('r_host') || url.hostname || '127.0.0.1';
  return `${url.protocol}//${host}:${rPort}`;
}

export function createRDuckDbConnectorFromLocation(): DuckDbConnector | null {
  const serverUrl = getRServerUrlFromLocation();
  if (!serverUrl) return null;

  const sessionToken = new URLSearchParams(window.location.hash.slice(1)).get(
    'r_token',
  );
  return createRDuckDbConnector({serverUrl, sessionToken});
}

export function createRDuckDbConnector({
  serverUrl,
  sessionToken,
}: {
  serverUrl: string;
  sessionToken?: string | null;
}): DuckDbConnector {
  const queryUrl = new URL('/api/arrow-query', ensureTrailingSlash(serverUrl));

  return createBaseDuckDbConnector(undefined, {
    executeQueryInternal: async <T extends TypeMap = TypeMap>(
      query: string,
      signal: AbortSignal,
    ): Promise<Table<T>> => {
      for (let attempt = 1; attempt <= QUERY_ATTEMPTS; attempt += 1) {
        try {
          const response = await fetch(queryUrl, {
            method: 'POST',
            headers: {
              Accept: `${ARROW_STREAM_MIME}, ${ARROW_FILE_MIME}, ${OCTET_STREAM_MIME}`,
              'Content-Type': 'application/json',
              ...(sessionToken
                ? {Authorization: `Bearer ${sessionToken}`}
                : {}),
            },
            body: JSON.stringify({sql: query, geoarrow: true}),
            signal,
          });

          if (!response.ok) {
            throw new Error(await getResponseError(response));
          }

          const contentType = response.headers.get('content-type')?.toLowerCase();
          if (!isArrowContentType(contentType)) {
            throw new Error(
              `Expected raw Arrow stream from R server, received ${contentType || 'unknown content type'}.`,
            );
          }

          const buffer = await response.arrayBuffer();
          if (buffer.byteLength === 0) {
            return tableFromArrays({}) as unknown as Table<T>;
          }

          return tableFromIPC<T>(new Uint8Array(buffer));
        } catch (error) {
          if (
            signal.aborted ||
            attempt === QUERY_ATTEMPTS ||
            !isTransientFetchError(error)
          ) {
            throw error;
          }

          await delay(QUERY_RETRY_DELAY_MS);
        }
      }

      throw new Error('R DuckDB query failed after retry.');
    },
    loadFileInternal: async () => {
      throw new Error('Loading files through the R DuckDB connector is not implemented.');
    },
    loadArrowInternal: async () => {
      throw new Error('Loading Arrow through the R DuckDB connector is not implemented.');
    },
    loadObjectsInternal: async () => {
      throw new Error('Loading objects through the R DuckDB connector is not implemented.');
    },
  });
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function isArrowContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return (
    contentType.includes(ARROW_STREAM_MIME) ||
    contentType.includes(ARROW_FILE_MIME) ||
    contentType.includes(OCTET_STREAM_MIME)
  );
}

function isTransientFetchError(error: unknown): boolean {
  return error instanceof TypeError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function getResponseError(response: Response): Promise<string> {
  const text = await response.text();
  let details = text.trim();

  try {
    const parsed = JSON.parse(text) as {error?: unknown; message?: unknown};
    details = String(parsed.error ?? parsed.message ?? details);
  } catch {
    // The R endpoint can return plain text for lower-level server failures.
  }

  return `R DuckDB query failed (${response.status} ${response.statusText}): ${details}`;
}
