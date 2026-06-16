import type {
  AiSliceState,
  QueryToolOptions,
  QueryToolOutput,
  QueryToolParameters,
} from '@sqlrooms/ai';
import {arrowTableToJson, splitSqlStatements} from '@sqlrooms/duckdb';
import type {DuckDbConnector, DuckDbSliceState} from '@sqlrooms/duckdb';
import type {StoreApi} from '@sqlrooms/room-shell';
import {tool} from 'ai';
import {z} from 'zod';

export const TolerantQueryToolParameters = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null) return value;
    const input = value as Record<string, unknown>;
    if (input.type === 'sql') return {...input, type: 'query'};
    return value;
  },
  z.object({
    type: z.literal('query').default('query'),
    sqlQuery: z.string(),
    reasoning: z.string().optional().default(''),
  }),
);

export function createTolerantQueryTool(
  store: StoreApi<AiSliceState & DuckDbSliceState>,
  options?: QueryToolOptions,
) {
  const {
    readOnly = true,
    autoSummary = false,
    numberOfRowsToShareWithLLM = 0,
  } = options || {};

  return tool<QueryToolParameters, QueryToolOutput>({
    description: `A tool for running SQL queries on the tables in the database.
                  Please only run one query at a time.
                  If a query fails, please don't try to run it again with the same syntax.
                  The type field may be "query" or "sql".`,
    inputSchema: TolerantQueryToolParameters as z.ZodType<QueryToolParameters>,
    execute: async (params, options): Promise<QueryToolOutput> => {
      const {sqlQuery} = params;
      const abortSignal = options?.abortSignal;

      try {
        const connector = await store.getState().db.getConnector();
        const parsedQuery = await store.getState().db.sqlSelectToJson(sqlQuery);

        if (
          parsedQuery.error &&
          parsedQuery.error_type !== 'not implemented'
        ) {
          throw new Error(parsedQuery.error_message);
        }

        if (readOnly) {
          if (parsedQuery.error) {
            throw new Error(
              `Query is not a valid SELECT statement: ${parsedQuery.error_message}`,
            );
          }
          if (
            parsedQuery.statements.length !== 1 ||
            parsedQuery.statements[0]?.node.type !== 'SELECT_NODE'
          ) {
            throw new Error('Query is not a valid SELECT statement');
          }
        }

        const result = await connector.query(sqlQuery, {signal: abortSignal});
        const summaryData = await (async () => {
          if (!autoSummary) return null;
          if (parsedQuery.error) return null;

          const lastNode =
            parsedQuery.statements[parsedQuery.statements.length - 1]?.node;
          if (
            lastNode?.type === 'SELECT_NODE' &&
            lastNode?.from_table?.show_type === 'SUMMARY'
          ) {
            return arrowTableToJson(result);
          }

          const statements = splitSqlStatements(sqlQuery);
          const lastStatement = statements[statements.length - 1];
          if (!lastStatement) return null;

          return getQuerySummary(connector, lastStatement, abortSignal);
        })();

        const firstRows =
          numberOfRowsToShareWithLLM > 0
            ? arrowTableToJson(result.slice(0, numberOfRowsToShareWithLLM))
            : [];

        return {
          success: true,
          data: {
            type: 'query' as const,
            summary: summaryData,
            ...(numberOfRowsToShareWithLLM > 0 ? {firstRows} : {}),
          },
          title: 'Query Result',
          sqlQuery,
        };
      } catch (error) {
        return {
          success: false,
          details: 'Query execution failed.',
          error: error instanceof Error ? error.message : 'Unknown error',
          title: 'Query Result',
          sqlQuery,
        };
      }
    },
    toModelOutput: ({output}) => ({
      type: 'text',
      value: JSON.stringify({
        success: output.success,
        data: output.data,
        ...(output.details ? {details: output.details} : {}),
        ...(output.error ? {error: output.error} : {}),
      }),
    }),
  });
}

async function getQuerySummary(
  connector: DuckDbConnector,
  sqlQuery: string,
  abortSignal?: AbortSignal,
) {
  if (!sqlQuery.toLowerCase().trim().startsWith('select')) {
    return null;
  }

  try {
    const summaryResult = await connector.query(
      `SUMMARIZE (
      ${sqlQuery}
    )`,
      {signal: abortSignal},
    );
    return arrowTableToJson(summaryResult);
  } catch (error) {
    console.warn('Failed to get summary for query. Error:', error);
    return null;
  }
}
