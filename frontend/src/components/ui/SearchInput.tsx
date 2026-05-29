"use client";

import { Search } from "lucide-react";
import type { CSSProperties } from "react";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible label; falls back to the placeholder. */
  ariaLabel?: string;
  /** Wrapper overrides (flex sizing, margins) for the specific surface. */
  style?: CSSProperties;
}

/**
 * The standard list-surface search affordance. One source of truth for the
 * Book, Market, and Venues rosters so they stay visually identical — wraps the
 * shared `lc-search` token styles instead of each surface re-inlining the
 * icon + input markup.
 */
export function SearchInput({ value, onChange, placeholder = "Search…", ariaLabel, style }: SearchInputProps) {
  return (
    <div className="lc-search" style={style}>
      <Search size={14} aria-hidden />
      <input
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel ?? placeholder}
      />
    </div>
  );
}
