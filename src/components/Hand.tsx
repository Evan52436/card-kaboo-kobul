'use client';

import type { SlotView } from '@/engine/project';
import type { PlayerId } from '@/engine/types';
import { placeKey } from '@/lib/flights';
import { Card } from './Card';

/**
 * A hand, laid out as one row of cards that scrolls sideways.
 *
 * Slots are rendered by index and never compacted: a player remembers positions,
 * so an emptied slot must stay visibly empty and in place. A hand can also be
 * longer than four (penalty cards, a late draw), so the row scrolls sideways rather than
 * refusing the extra. See AGENTS.md §9.
 */
export function Hand({
  slots,
  label,
  selectableSlots = [],
  liveSlots = [],
  selectedSlot = null,
  onSelect,
  compact = false,
  ownerId,
}: {
  slots: SlotView[];
  label: string;
  /** Slot indices the caller may tap right now. Everything else is inert. */
  selectableSlots?: number[];
  /**
   * The subset of `selectableSlots` to draw attention to. A separate prop rather
   * than "whatever is selectable", because selectable is a much wider set than
   * live: a Jack's blind swap makes every card on the table selectable, and a
   * table where everything pulses says nothing about anything.
   */
  liveSlots?: number[];
  selectedSlot?: number | null;
  onSelect?: (slot: number) => void;
  compact?: boolean;
  /**
   * Whose hand this is. It names each slot (`data-flight`) so a card flying to or
   * from it can find where it is on screen — see `CardFlights`.
   */
  ownerId?: PlayerId;
}) {
  return (
    <div className={`kb-hand${compact ? ' kb-hand--compact' : ''}`} aria-label={label} role="group">
      {slots.map((slot) => {
        const selectable = selectableSlots.includes(slot.index);
        return (
          <div
            className="kb-hand__cell"
            key={slot.index}
            data-flight={ownerId ? placeKey({ zone: 'slot', playerId: ownerId, slot: slot.index }) : undefined}
          >
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
              live={liveSlots.includes(slot.index)}
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
