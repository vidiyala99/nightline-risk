"use client";

export interface FilterOption {
  value: string;
  label: string;
}

interface FilterSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  ariaLabel: string;
}

/**
 * The standard list-surface filter dropdown (borough / type / sort). One
 * source of truth for the Book, Market, and Venues rosters — wraps the shared
 * `.ui-select` token styling instead of each surface re-inlining a styled
 * <select> and its options.
 */
export function FilterSelect({ value, onChange, options, ariaLabel }: FilterSelectProps) {
  return (
    <select className="ui-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
