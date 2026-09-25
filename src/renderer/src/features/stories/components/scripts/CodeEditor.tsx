// JavaScript editor for story scripts (CodeMirror 6): line numbers, Tab to
// indent, JS highlighting in the theme's colours, folding, search, bracket
// matching and live syntax-error marks. Handles 400 KB libraries smoothly.
import { useEffect, useRef } from 'react'
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { bracketMatching, ensureSyntaxTree, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, placeholder as cmPlaceholder } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { cn } from '@/lib/utils'

const theme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '12.5px', color: 'var(--fg)', backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65', overflow: 'auto' },
    '.cm-content': { caretColor: 'var(--accent)', padding: '12px 0' },
    '.cm-line': { padding: '0 16px 0 10px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in oklab, var(--accent) 26%, transparent) !important'
    },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--fg-3)', border: 'none', borderRight: '1px solid var(--line)' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px', minWidth: '44px' },
    '.cm-activeLine': { backgroundColor: 'rgb(255 255 255 / 0.028)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
    '.cm-foldGutter .cm-gutterElement': { color: 'var(--fg-3)', padding: '0 4px' },
    '.cm-foldPlaceholder': { backgroundColor: 'rgb(255 255 255 / 0.08)', border: 'none', color: 'var(--fg-2)', borderRadius: '5px', padding: '0 6px' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in oklab, var(--accent-2) 30%, transparent)', color: 'inherit', outline: 'none' },
    '.cm-selectionMatch': { backgroundColor: 'rgb(255 255 255 / 0.07)' },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in oklab, var(--accent) 22%, transparent)', outline: '1px solid color-mix(in oklab, var(--accent) 45%, transparent)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklab, var(--accent) 45%, transparent)' },
    '.cm-panels': { backgroundColor: 'var(--panel-solid)', color: 'var(--fg)', borderColor: 'var(--line)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
    '.cm-panel.cm-search': { padding: '8px 12px', fontFamily: 'var(--font-sans)', fontSize: '12px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'var(--font-sans)', fontSize: '12px' },
    '.cm-textfield': { backgroundColor: 'rgb(255 255 255 / 0.05)', border: '1px solid var(--line-strong)', borderRadius: '7px', color: 'var(--fg)', padding: '3px 8px' },
    '.cm-button': { backgroundImage: 'none', backgroundColor: 'rgb(255 255 255 / 0.06)', border: '1px solid var(--line)', borderRadius: '7px', color: 'var(--fg)', padding: '3px 10px' },
    '.cm-panel.cm-search label': { color: 'var(--fg-2)' },
    '.cm-tooltip': { backgroundColor: 'var(--panel-solid)', border: '1px solid var(--line-strong)', borderRadius: '10px', color: 'var(--fg)', overflow: 'hidden' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgb(255 255 255 / 0.1)', color: 'var(--fg)' },
    '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
    '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)', textUnderlineOffset: '3px' },
    '.cm-gutter-lint': { width: '14px' },
    '.cm-placeholder': { color: 'var(--fg-3)', fontStyle: 'italic' }
  },
  { dark: true }
)

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: 'var(--accent-2)' },
  { tag: [t.string, t.special(t.string), t.character], color: 'color-mix(in oklab, var(--accent) 72%, #fff)' },
  { tag: [t.regexp, t.escape], color: 'var(--art-5)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--art-3)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--fg-3)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'color-mix(in oklab, var(--accent-2) 55%, #fff)' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--fg)' },
  { tag: [t.className, t.typeName, t.namespace], color: 'var(--art-2)' },
  { tag: [t.propertyName], color: 'color-mix(in oklab, var(--fg) 82%, var(--accent-2))' },
  { tag: [t.self, t.special(t.variableName)], color: 'var(--art-4)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: 'var(--fg-2)' },
  { tag: t.invalid, color: 'var(--danger)' }
])

/** Syntax errors from the parse tree (Lezer marks where parsing broke down). */
const syntaxErrors = linter(
  (view) => {
    const tree = ensureSyntaxTree(view.state, view.state.doc.length, 400)
    if (!tree) return []
    const found: Diagnostic[] = []
    tree.iterate({
      enter: (n) => {
        if (!n.type.isError || found.length >= 20) return
        const from = Math.min(n.from, view.state.doc.length)
        const to = Math.min(Math.max(n.to, from + 1), view.state.doc.length)
        found.push({ from, to, severity: 'error', message: 'Syntax error' })
      }
    })
    return found
  },
  { delay: 700 }
)

function extensions(onChange: (text: string) => void, editable: Compartment, readOnly: boolean, hint?: string): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter({ markerDOM: (open) => Object.assign(document.createElement('span'), { textContent: open ? '▾' : '▸' }) }),
    lintGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of('  '),
    EditorState.tabSize.of(4),
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: false }),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    javascript(),
    syntaxErrors,
    theme,
    ...(hint ? [cmPlaceholder(hint)] : []),
    editable.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u.state.doc.toString())
    })
  ]
}

/**
 * Uncontrolled editor: `value` seeds it and is re-applied whenever `resetKey`
 * changes (e.g. another script was loaded). Edits flow out through `onChange`.
 */
export function CodeEditor({
  value,
  resetKey,
  onChange,
  readOnly = false,
  placeholder,
  className,
  autoFocus
}: {
  value: string
  resetKey?: string | number
  onChange: (text: string) => void
  readOnly?: boolean
  placeholder?: string
  className?: string
  autoFocus?: boolean
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const editable = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: valueRef.current, extensions: extensions((t) => onChangeRef.current(t), editable.current, readOnly, placeholder) })
    })
    view.current = v
    if (autoFocus) v.focus()
    return () => {
      v.destroy()
      view.current = null
    }
    // Rebuilt only when the document is reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) })
  }, [readOnly])

  return <div ref={host} className={cn('min-h-0 overflow-hidden', className)} />
}
