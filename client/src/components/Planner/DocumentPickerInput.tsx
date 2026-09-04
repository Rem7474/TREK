import type { RefObject } from 'react'

/**
 * The one import door, for both shells.
 *
 * The desktop planner, the phone planner and Costs all offer a single button
 * that opens the OS picker — which already shows Camera beside Files — and the
 * choice the user makes is the file itself: a photo goes to the receipt scanner,
 * anything else to the booking import. The routing lives in useTripPlanner; this
 * is only the input element, so neither shell writes its own copy of "read the
 * files, clear the field, hand them over".
 */
export default function DocumentPickerInput({ inputRef, accept, onPicked }: {
  inputRef: RefObject<HTMLInputElement | null>
  accept: string
  onPicked: (files: File[]) => void
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={accept}
      className="hidden"
      onChange={e => {
        const list = e.target.files ? Array.from(e.target.files) : []
        // Cleared before routing so picking the same file twice in a row still
        // fires a change event.
        e.target.value = ''
        onPicked(list)
      }}
    />
  )
}
