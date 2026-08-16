interface FilterChipsProps<T extends string> {
  options: Array<{ key: T; label: string }>
  value: T
  onChange: (key: T) => void
  counts?: Partial<Record<T, number>>
  ariaLabel?: string
}

export function FilterChips<T extends string>({ options, value, onChange, counts, ariaLabel }: FilterChipsProps<T>) {
  return (
    <div className="filters" role="group" aria-label={ariaLabel ?? 'Filters'}>
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={`chip${value === opt.key ? ' active' : ''}`}
          aria-pressed={value === opt.key}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
          {counts && counts[opt.key] != null && <span className="chip-count">{counts[opt.key]}</span>}
        </button>
      ))}
    </div>
  )
}
