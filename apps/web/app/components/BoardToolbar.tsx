"use client";

import { useState, type ReactNode, type RefObject } from "react";
import { SearchBar, type SearchBarHandle } from "./SearchBar";
import { FilterPanel } from "./FilterPanel";
import { SortPanel } from "./SortPanel";
import { ToolbarGroup, ToolbarSegment } from "./board-header/ToolbarGroup";
import { FilterIcon, SortIcon } from "./board-header/icons";
import type { BoardColumn } from "@deckgauge/shared";
import type { SortConfig } from "../utils/sort-projects";

interface BoardToolbarProps {
  columns?: BoardColumn[];
  onSearch?: (query: string) => void;
  onFilterChange?: (rules: { column: string; condition: string; value: string }[]) => void;
  sortConfig?: SortConfig | null;
  onSortChange?: (config: SortConfig | null) => void;
  searchRef?: RefObject<SearchBarHandle | null>;
  /**
   * The column-visibility control, rendered as the group's last segment. It is
   * injected rather than owned here because its state lives with the board's
   * column layout in `BoardView`.
   */
  columnsControl?: ReactNode;
}

/**
 * The board's read-side view controls, as one segmented instrument.
 *
 * Everything here is a client-side read, so nothing in it is permission-gated.
 * The two edit-tier affordances this component used to carry have moved to
 * where they belong: "Automations" is board configuration and now lives in the
 * board menu behind the title (`BoardHeader`), and "+ Add Column" was a
 * duplicate — the Columns panel has always ended with its own "＋ Add column"
 * row, driving the same modal.
 */
export function BoardToolbar({
  columns,
  onSearch,
  onFilterChange,
  sortConfig,
  onSortChange,
  searchRef,
  columnsControl,
}: BoardToolbarProps) {
  const [openPanel, setOpenPanel] = useState<"filter" | "sort" | null>(null);
  const [filterCount, setFilterCount] = useState(0);

  // One popover at a time — two stacked panels anchored to the same edge would
  // overlap.
  const toggle = (panel: "filter" | "sort") =>
    setOpenPanel((prev) => (prev === panel ? null : panel));

  return (
    <div className="relative">
      <ToolbarGroup>
        {onSearch && (
          <SearchBar
            ref={searchRef}
            onSearch={onSearch}
            variant="embedded"
            inputAriaLabel="Search items"
          />
        )}

        <ToolbarSegment
          label="Filter"
          icon={<FilterIcon className="h-3.5 w-3.5" />}
          count={filterCount}
          isActive={openPanel === "filter"}
          onClick={() => toggle("filter")}
        />

        <ToolbarSegment
          label="Sort"
          icon={<SortIcon className="h-3.5 w-3.5" />}
          count={sortConfig ? 1 : 0}
          isActive={openPanel === "sort"}
          onClick={() => toggle("sort")}
        />

        {columnsControl}
      </ToolbarGroup>

      {openPanel === "filter" && (
        <div className="absolute right-0 top-full z-40">
          <FilterPanel
            columns={columns || []}
            onChange={(rules) => {
              setFilterCount(rules.length);
              onFilterChange?.(rules);
            }}
            onClose={() => setOpenPanel(null)}
          />
        </div>
      )}

      {openPanel === "sort" && (
        <div className="absolute right-0 top-full z-40">
          <SortPanel
            columns={columns || []}
            sortConfig={sortConfig ?? null}
            onChange={(config) => {
              onSortChange?.(config);
              if (!config) setOpenPanel(null);
            }}
            onClose={() => setOpenPanel(null)}
          />
        </div>
      )}
    </div>
  );
}
