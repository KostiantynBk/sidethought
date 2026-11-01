import { retrievalEvidenceSchemaWithLimits, type RetrievalEvidence } from '../../contract/models.js';
import { object } from './stream.js';

type Limits = { maxEvidenceResults: number; maxSnippetChars: number };

export function extractEvidence(response: Record<string, unknown>, limits: Limits): {
  evidence: RetrievalEvidence;
  queryCount: number;
  answer: string;
} {
  const output = Array.isArray(response.output) ? response.output : [];
  const evidence: RetrievalEvidence = { completedSearchCalls: 0, issuedQueries: [], results: [] };
  let queryCount = 0;
  const answer: string[] = [];
  for (const raw of output) {
    const item = object(raw);
    if (!item) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        const part = object(rawPart);
        if (part?.type === 'output_text' && typeof part.text === 'string') answer.push(part.text);
      }
    }
    if (item.type !== 'web_search_call') continue;
    if (item.status === 'completed') evidence.completedSearchCalls++;
    const action = object(item.action);
    const queries = action?.queries;
    const single = action?.query;
    if (Array.isArray(queries) && queries.length > 0 && queries.every(query => typeof query === 'string' && query)) {
      evidence.issuedQueries.push(...queries);
      queryCount += queries.length;
    } else if (typeof single === 'string' && single.length > 0) {
      // Live Meta responses (Nov 1) carry an empty `queries` list plus one `query` string.
      evidence.issuedQueries.push(single);
      queryCount += 1;
    } else {
      // §4.5: unreadable queries are counted conservatively as three per tool call.
      queryCount += 3;
    }
    if (!Array.isArray(item.results)) continue;
    for (const rawResult of item.results) {
      const result = object(rawResult);
      if (!result || typeof result.url !== 'string' || typeof result.snippet !== 'string') continue;
      try {
        const url = new URL(result.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      } catch {
        continue;
      }
      if (evidence.results.length >= limits.maxEvidenceResults) break;
      evidence.results.push({
        url: result.url,
        ...(typeof result.title === 'string' && result.title.length ? { title: result.title } : {}),
        snippet: result.snippet.slice(0, limits.maxSnippetChars),
      });
    }
  }
  return {
    evidence: retrievalEvidenceSchemaWithLimits(limits).parse(evidence),
    queryCount,
    answer: answer.join('\n'),
  };
}
