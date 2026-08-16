import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useFocusTrap } from '../lib/use-focus-trap'

export interface PaletteItem {
  id: string
  label: string
  group: string
  to?: string
  action?: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  items: PaletteItem[]
  onNavigate: (item: PaletteItem) => void
}

const MAX_VISIBLE = 10

export function CommandPalette({ open, onClose, items, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (item) => item.label.toLowerCase().includes(q) || item.group.toLowerCase().includes(q),
    )
  }, [items, query])

  const visible = useMemo(() => {
    const rows: Array<{ item: PaletteItem; index: number }> = []
    for (let i = 0; i < filtered.length && i < MAX_VISIBLE; i++) {
      rows.push({ item: filtered[i], index: i })
    }
    return rows
  }, [filtered])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    const prev = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => prev?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useFocusTrap(panelRef)

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      setActive((a) => (visible.length === 0 ? 0 : (a + 1) % visible.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      setActive((a) => (visible.length === 0 ? 0 : (a - 1 + visible.length) % visible.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const item = visible[active]?.item
      if (item) onNavigate(item)
    }
  }

  if (!open) return null

  const hidden = filtered.length - visible.length

  const rows: ReactNode[] = []
  let lastGroup: string | null = null
  for (const { item, index } of visible) {
    if (item.group !== lastGroup) {
      lastGroup = item.group
      rows.push(
        <div key={`group-${item.group}`} className="nav-group-label">
          {item.group}
        </div>,
      )
    }
    rows.push(
      <div
        key={item.id}
        id={`palette-option-${index}`}
        role="option"
        aria-selected={index === active}
        className={`nav-item${index === active ? ' active' : ''}`}
        onClick={() => onNavigate(item)}
      >
        {item.label}
      </div>,
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Command palette</h2>
        <p className="muted small">Type to filter, arrows to move, Enter to jump</p>
        <input
          ref={inputRef}
          type="text"
          className="field"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onInputKeyDown}
          aria-label="Palette query"
          aria-controls="palette-list"
          aria-activedescendant={visible.length > 0 ? `palette-option-${active}` : undefined}
        />
        <div id="palette-list" role="listbox" aria-label="Palette results">
          {rows}
          {hidden > 0 && <div className="muted small">+{hidden} more</div>}
          {visible.length === 0 && <div className="muted small">No matches</div>}
        </div>
      </div>
    </div>
  )
}
