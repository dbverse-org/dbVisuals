import {RoomPanel} from '@sqlrooms/room-shell';
import {SchemaExplorer} from '@sqlrooms/sql-editor';
import {FileDropzone} from '@sqlrooms/dropzone';
import {useRoomStore} from '../store';
import {convertToValidColumnOrTableName} from '@sqlrooms/utils';
import {isWasmDuckDbConnector, type DuckDbConnector} from '@sqlrooms/duckdb';
import {toast} from '@sqlrooms/ui';
import {tableFromIPC} from 'apache-arrow';
import type {FC} from 'react';

type DroppedFileResult = {tableName: string; kind: 'table' | 'database'};

/**
 * Load a dropped file into the in-browser DuckDB instance.
 *
 * - `.duckdb` / `.ddb`: register the raw bytes and ATTACH the database
 *   read-only (WASM connector only — there is no writable filesystem).
 * - `.arrow`: parse the Arrow IPC payload (file or stream framing) and insert.
 * - everything else (csv/tsv/parquet/json): let DuckDB auto-detect.
 */
async function loadDroppedFile(
  connector: DuckDbConnector,
  file: File,
): Promise<DroppedFileResult> {
  const lower = file.name.toLowerCase();

  if (lower.endsWith('.duckdb') || lower.endsWith('.ddb')) {
    if (!isWasmDuckDbConnector(connector)) {
      throw new Error(
        'Attaching .duckdb databases is only supported in the in-browser (WASM) workspace.',
      );
    }
    const db = connector.getDb();
    const alias = convertToValidColumnOrTableName(
      file.name.replace(/\.(duckdb|ddb)$/i, ''),
    );
    const buffer = new Uint8Array(await file.arrayBuffer());
    // Allow re-dropping the same file name without a "already registered" error.
    await db.dropFile(file.name).catch(() => undefined);
    await db.registerFileBuffer(file.name, buffer);
    await connector.execute(`ATTACH '${file.name}' AS "${alias}" (READ_ONLY)`);
    return {tableName: alias, kind: 'database'};
  }

  const tableName = convertToValidColumnOrTableName(file.name);

  if (lower.endsWith('.arrow')) {
    const table = tableFromIPC(new Uint8Array(await file.arrayBuffer()));
    await connector.loadArrow(table, tableName);
    return {tableName, kind: 'table'};
  }

  await connector.loadFile(file, tableName);
  return {tableName, kind: 'table'};
}

export const DataSourcesPanel: FC = () => {
  const connector = useRoomStore((state) => state.db.connector);
  const refreshTableSchemas = useRoomStore(
    (state) => state.db.refreshTableSchemas,
  );
  return (
    <RoomPanel>
      <FileDropzone
        className="h-50 p-5"
        acceptedFormats={{
          'text/csv': ['.csv'],
          'text/tsv': ['.tsv'],
          'text/parquet': ['.parquet'],
          'text/json': ['.json'],
          'application/vnd.apache.arrow.file': ['.arrow'],
          'application/octet-stream': ['.duckdb', '.ddb'],
        }}
        onDrop={async (files) => {
          for (const file of files) {
            try {
              const {tableName, kind} = await loadDroppedFile(connector, file);
              toast.success(
                kind === 'database' ? 'Database attached' : 'Table created',
                {
                  description:
                    kind === 'database'
                      ? `${file.name} attached read-only as ${tableName}`
                      : `File ${file.name} loaded as ${tableName}`,
                },
              );
            } catch (error) {
              toast.error('Error', {
                description: `Error loading file ${file.name}: ${error}`,
              });
            }
          }
          await refreshTableSchemas();
        }}
      >
        <div className="text-muted-foreground text-xs">
          Drop CSV, TSV, Parquet, JSON, Arrow, or a DuckDB database file. Files
          you add stay local to your browser.
        </div>
      </FileDropzone>
      <SchemaExplorer>
        <SchemaExplorer.Header>
          <SchemaExplorer.RefreshButton />
        </SchemaExplorer.Header>
        <SchemaExplorer.Tree className="h-full" />
      </SchemaExplorer>
    </RoomPanel>
  );
};
