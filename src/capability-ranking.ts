export type CapabilitySource = 'project-task' | 'tool'

/** One capability visible to the calling Agent. */
export interface CapabilityCandidate {
  source: CapabilitySource
  id: string
  name: string
  description: string
}

/** Ranked capability plus the strongest deterministic match class. */
export interface CapabilityMatch extends CapabilityCandidate {
  score: number
  reason: string
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en').trim()
}

function tokens(value: string): string[] {
  return normalize(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function score(query: string, row: CapabilityCandidate): Pick<CapabilityMatch, 'reason' | 'score'> | undefined {
  const name = normalize(row.name)
  const nameTokens = tokens(row.name)
  const description = normalize(row.description)
  const descriptionTokens = tokens(row.description)
  if (name === query) return { score: 120, reason: 'exact-name' }
  if (name.startsWith(query)) return { score: 100, reason: 'name-prefix' }
  if (nameTokens.includes(query)) return { score: 90, reason: 'name-token' }
  if (nameTokens.some(token => token.startsWith(query))) return { score: 75, reason: 'name-token-prefix' }
  if (descriptionTokens.includes(query)) return { score: 40, reason: 'description-token' }
  if (description.includes(query)) return { score: 20, reason: 'description-match' }
  return undefined
}

/** Rank visible capabilities without accessing another registry or network service. */
export function rankCapabilities(
  query: string,
  rows: readonly CapabilityCandidate[],
  limit: number,
): CapabilityMatch[] {
  const normalized = normalize(query)
  if (normalized === '') throw new Error('query must be nonblank')
  if ([...query].length > 256) throw new Error('query must be at most 256 characters')
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error('limit must be an integer from 1 through 10')
  }
  return rows.flatMap((row): CapabilityMatch[] => {
    const match = score(normalized, row)
    return match === undefined ? [] : [{ ...row, ...match }]
  }).sort((left, right) => right.score - left.score
    || left.source.localeCompare(right.source, 'en')
    || left.id.localeCompare(right.id, 'en'))
    .slice(0, limit)
}
