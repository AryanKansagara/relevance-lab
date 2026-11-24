// Values that arrive from outside the app (the URL query, a shared link, saved storage) and name a tab or a
// sample. They are checked here so an unknown value is ignored and reported, never trusted or silently replaced.
import { SAMPLES } from './samples.ts'

export const TABS = ['explain', 'compare', 'tune', 'hybrid', 'lints', 'mini'] as const
export type Tab = (typeof TABS)[number]

export const isTab = (v: unknown): v is Tab => typeof v === 'string' && (TABS as readonly string[]).includes(v)
export const isSample = (v: unknown): v is string => typeof v === 'string' && SAMPLES.some((s) => s.id === v)

const shown = (v: string) => JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)

/**
 * Reads ?sample= and ?tab=. Case and surrounding spaces are not significant (all names are lower case), an empty
 * value counts as absent, and an unknown value is dropped and reported.
 */
export function readLabParams(search: string): { sample?: string; tab?: Tab; problems: string[] } {
  const q = new URLSearchParams(search)
  const out: { sample?: string; tab?: Tab; problems: string[] } = { problems: [] }
  const sample = q.get('sample')
  if (sample) {
    const id = sample.trim().toLowerCase()
    if (isSample(id)) out.sample = id
    else out.problems.push(`Unknown sample ${shown(sample)}, so it was ignored.`)
  }
  const tab = q.get('tab')
  if (tab) {
    const name = tab.trim().toLowerCase()
    if (isTab(name)) out.tab = name
    else out.problems.push(`Unknown tab ${shown(tab)}, so it was ignored.`)
  }
  return out
}

/** Drops an unknown tab or sample from a decoded share link and says what was dropped. */
export function checkSharedState<T extends object>(state: T): { state: T; problems: string[] } {
  const problems: string[] = []
  const next: { sample?: unknown; tab?: unknown } = { ...state }
  if (next.sample !== undefined && !isSample(next.sample)) {
    problems.push(`This share link names an unknown sample ${shown(String(next.sample))}, so it was ignored.`)
    delete next.sample
  }
  if (next.tab !== undefined && !isTab(next.tab)) {
    problems.push(`This share link names an unknown tab ${shown(String(next.tab))}, so it was ignored.`)
    delete next.tab
  }
  return { state: next as T, problems }
}
