'use client';

import type { SlotView } from '@/engine/project';
import { Card } from './Card';

/**
 * A hand, laid out as the 2×2 square the brief describes.
 *
 * Slots are rendered by index and never compacted: a player remembers positions,
 * so an emptied slot must stay visibly empty and in place. A hand can also be
 * longer than four (penalty cards, a late draw), so the grid grows rather than
 * refusing the extra. See AGENTS.md §9.
 */
export function Hand({
  slots,
  label,
  selectableSlots = [],
  selectedSlot = null,
  onSelect,
  compact = false,
}: {
  slots: SlotView[];
  label: string;
  /** Slot indices the caller may tap right now. Everything else is inert. */
  selectableSlots?: number[];
  selectedSlot?: number | null;
  onSelect?: (slot: number) => void;
  compact?: boolean;
}) {
  return (
    <div className={`kb-hand${compact ? ' kb-hand--compact' : ''}`} aria-label={label} role="group">
      {slots.map((slot) => {
        const selectable = selectableSlots.includes(slot.index);
        return (
          <div className="kb-hand__cell" key={slot.index}>
            <Card
              // `gen` as the key: when the slot's contents change, the card
              // re-mounts and the flip replays. That is the animation hook the
              // projection exists to provide without shipping ids.
              key={`${slot.index}:${slot.gen}`}
              // The projection has already decided what this viewer may see; a
              // null face means face-down, and no component may overrule that.
              card={slot.face}
              faceDown={slot.occupied && !slot.face}
              empty={!slot.occupied}
              selected={selectedSlot === slot.index}
              label={`${label} slot ${slot.index + 1}`}
              onClick={selectable && onSelect ? () => onSelect(slot.index) : undefined}
              disabled={!selectable}
            />
            <span className="kb-hand__index" aria-hidden="true">
              {slot.index + 1}
            </span>
          </div>
        );
      })}
    </div>
  );
}
