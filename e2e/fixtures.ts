import { test as base, expect } from '@playwright/test'

/**
 * Every test runs signed out with all external hosts blocked (Google Fonts is
 * answered with an empty stylesheet so the page settles) and fails on any
 * uncaught page error, console error or request that left the app origin.
 */
export const test = base.extend<{ problems: string[]; knownPageErrors: RegExp[] }>({
  /** Page errors a test tolerates because they are tracked as app bugs. Keep this empty otherwise. */
  knownPageErrors: [[], { option: true }],
  problems: [
    async ({ page, baseURL, knownPageErrors }, use) => {
      const problems: string[] = []
      const origin = new URL(baseURL!).origin
      await page.route('**/*', (route) => {
        const url = route.request().url()
        if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
        if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
        problems.push(`external request blocked: ${url}`)
        return route.abort()
      })
      page.on('pageerror', (e) => {
        if (!knownPageErrors.some((re) => re.test(e.message))) problems.push(`pageerror: ${e.message}`)
      })
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`console.error: ${m.text()}`)
      })
      await use(problems)
      expect(problems, 'no uncaught errors and no external requests').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

export const STORAGE_KEY = 'relevance-lab:v1'
