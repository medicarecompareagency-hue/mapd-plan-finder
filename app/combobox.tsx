"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface ComboboxProps {
  label: string;
  name: string;
  value: string;
  onChange: (name: string, value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  onInputChange?: (text: string) => void;
}

export default function Combobox({
  label,
  name,
  value,
  onChange,
  options,
  placeholder = "Type to search...",
  disabled = false,
  onInputChange,
}: ComboboxProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? "";

  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  const selectOption = useCallback(
    (optValue: string) => {
      onChange(name, optValue);
      setQuery("");
      setOpen(false);
      setHighlightedIndex(-1);
    },
    [name, onChange],
  );

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
        setHighlightedIndex(-1);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const item = listRef.current.children[highlightedIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (highlightedIndex >= 0 && filtered[highlightedIndex]) {
          selectOption(filtered[highlightedIndex].value);
        }
        break;
      case "Escape":
        setOpen(false);
        setQuery("");
        setHighlightedIndex(-1);
        break;
    }
  }

  return (
    <div className="flex flex-col gap-1" ref={containerRef}>
      <label htmlFor={name} className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
        {label}
      </label>
      <div className="relative">
        <input
          suppressHydrationWarning={true}
          ref={inputRef}
          id={name}
          type="text"
          disabled={disabled}
          className="h-9 w-full rounded-md border border-gray-300 bg-white px-2 pr-7 text-sm text-gray-800 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-400"
          placeholder={value ? selectedLabel : placeholder}
          value={open ? query : value ? selectedLabel : ""}
          onChange={(e) => {
            const text = e.target.value;
            setQuery(text);
            setHighlightedIndex(-1);
            if (!open) setOpen(true);
            onInputChange?.(text);
          }}
          onFocus={() => {
            setOpen(true);
            setQuery("");
          }}
          onKeyDown={handleKeyDown}
          autoComplete="off"
        />
        {/* Clear button / chevron */}
        {value ? (
          <button
            type="button"
            tabIndex={-1}
            className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
            onClick={() => {
              selectOption("");
              inputRef.current?.focus();
            }}
            aria-label={`Clear ${label}`}
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        ) : (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </span>
        )}

        {/* Dropdown */}
        {open && (
          <ul
            ref={listRef}
            className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg text-sm"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-gray-400 italic">No matches</li>
            ) : (
              filtered.map((opt, i) => (
                <li
                  key={opt.value}
                  className={`cursor-pointer px-3 py-1.5 ${
                    i === highlightedIndex
                      ? "bg-blue-600 text-white"
                      : opt.value === value
                        ? "bg-blue-50 text-blue-700 font-medium"
                        : "text-gray-800 hover:bg-blue-600 hover:text-white"
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent blur
                    selectOption(opt.value);
                  }}
                  onMouseEnter={() => setHighlightedIndex(i)}
                >
                  {opt.label}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
