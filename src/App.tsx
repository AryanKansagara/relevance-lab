import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import Landing from './Landing.tsx'

const Tool = lazy(() => import('./Tool.tsx'))

export function go(href: string) {
  history.pushState({}, '', href)
  dispatchEvent(new PopStateEvent('popstate'))
  scrollTo(0, 0)
  const hash = href.split('#')[1]
  if (hash) setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' }), 60)
}

function usePath() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const on = () => setPath(location.pathname)
    addEventListener('popstate', on)
    return () => removeEventListener('popstate', on)
  }, [])
  return path
}

export function link(href: string) {
  return {
    href,
    onClick: (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return
      e.preventDefault()
      go(href)
    },
  }
}

function ThemeToggle() {
  const [mode, setMode] = useState(document.documentElement.dataset.themeMode ?? 'light')
  const next = mode === 'dark' ? 'light' : 'dark'
  return (
    <button
      className="icon-btn"
      aria-label={`Switch to ${next} theme`}
      data-tip={`Switch to ${next} theme`}
      onClick={() => {
        document.documentElement.dataset.themeMode = next
        localStorage.setItem('themeMode', next)
        setMode(next)
      }}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        {mode === 'dark' ? (
          <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="10" cy="10" r="3.6" />
            <path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4" />
          </g>
        ) : (
          <path d="M16.5 12.4A7 7 0 0 1 7.6 3.5a7 7 0 1 0 8.9 8.9Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        )}
      </svg>
    </button>
  )
}

/** Single delegated tooltip: anything with data-tip gets it, including SVG marks. */
function TipLayer() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = ref.current
      if (!el) return
      const target = (e.target as Element | null)?.closest?.('[data-tip]')
      const tip = target?.getAttribute('data-tip')
      if (!tip) {
        el.style.opacity = '0'
        return
      }
      el.textContent = tip
      el.style.opacity = '1'
      const w = el.offsetWidth
      const h = el.offsetHeight
      el.style.transform = `translate(${Math.max(8, Math.min(innerWidth - w - 8, e.clientX + 14))}px, ${e.clientY + h + 22 > innerHeight ? e.clientY - h - 10 : e.clientY + 16}px)`
    }
    addEventListener('pointermove', move, { passive: true })
    return () => removeEventListener('pointermove', move)
  }, [])
  return <div ref={ref} className="tip" role="presentation" />
}

export default function App() {
  const path = usePath()
  const inTool = path === '/app' || path.startsWith('/app/')
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <div className="top-in">
          <a className="brand" {...link('/')}>
            <span className="mono-badge" aria-hidden="true">RL</span>
            <span>Relevance Lab</span>
          </a>
          <nav className="top-nav" aria-label="Main">
            <a {...link('/#how')}>How it works</a>
            <a {...link('/app?sample=ecommerce')}>Samples</a>
            <a href="https://www.elastic.co/docs/reference/elasticsearch/rest-apis/search-explain" target="_blank" rel="noreferrer">Explain docs</a>
          </nav>
          <div className="top-end">
            <ThemeToggle />
            {!inTool && <a className="btn primary" {...link('/app')}>Open the lab</a>}
          </div>
        </div>
      </header>
      <main id="main">
        {inTool ? (
          <Suspense fallback={<div className="page-load"><span className="spin" />Loading the lab</div>}>
            <Tool />
          </Suspense>
        ) : (
          <Landing />
        )}
      </main>
      <footer className="foot">
        <div className="foot-in">
          <span>Built by Aryan Kansagara. Independent project, not affiliated with Elastic.</span>
          <span className="foot-note">Everything runs in your browser. Pasted responses never leave this tab.</span>
        </div>
      </footer>
      <TipLayer />
    </>
  )
}
