// Keyframes and small utilities used only by the Stories section.
const CSS = `
@keyframes st-token { from { opacity: 0; filter: blur(4px) } to { opacity: 1; filter: blur(0) } }
.st-token { animation: st-token .55s cubic-bezier(.22,1,.36,1) both; }

.st-fresh {
  background-image: linear-gradient(to top, color-mix(in oklab, var(--accent) 55%, transparent) 0 1px, transparent 1px);
  background-size: 100% 1.9em;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.st-fresh-line {
  text-decoration-line: underline;
  text-decoration-color: color-mix(in oklab, var(--accent) 45%, transparent);
  text-decoration-thickness: 1px;
  text-underline-offset: .32em;
  transition: text-decoration-color .6s ease;
}
.st-stale-line {
  text-decoration-line: underline;
  text-decoration-color: transparent;
  text-decoration-thickness: 1px;
  text-underline-offset: .32em;
  transition: text-decoration-color .8s ease;
}

@keyframes st-caret { 50% { opacity: 0 } }
.st-caret { display: inline-block; width: .5em; height: 1.05em; vertical-align: -.15em; margin-left: 2px; border-radius: 2px; background: var(--accent); animation: st-caret 1s steps(1) infinite; }

@keyframes st-glow { 0%,100% { opacity: .35; transform: scale(.94) } 50% { opacity: .75; transform: scale(1.05) } }
.st-glow { animation: st-glow 3.2s ease-in-out infinite; }

@keyframes st-drift { from { transform: translate3d(0,0,0) scale(1) } to { transform: translate3d(0,-2%,0) scale(1.06) } }
.st-drift { animation: st-drift 14s ease-in-out infinite alternate; }

.st-fade-mask { mask-image: linear-gradient(to bottom, black 55%, transparent); }
`

export function StoryStyles(): React.JSX.Element {
  return <style>{CSS}</style>
}
