// FE-DOCPICK-001 to FE-DOCPICK-003
import { createRef } from 'react'
import { fireEvent, render } from '@testing-library/react'
import DocumentPickerInput from './DocumentPickerInput'

function setup(onPicked = vi.fn()) {
  const ref = createRef<HTMLInputElement>()
  const { container } = render(
    <DocumentPickerInput inputRef={ref} accept=".pdf,.jpg" onPicked={onPicked} />
  )
  return { input: container.querySelector('input') as HTMLInputElement, onPicked, ref }
}

describe('DocumentPickerInput', () => {
  it('FE-DOCPICK-001: opens on the types the caller says are readable, and stays out of the layout', () => {
    const { input, ref } = setup()
    expect(input.accept).toBe('.pdf,.jpg')
    expect(input.multiple).toBe(true)
    expect(input.className).toContain('hidden')
    // The shells open it through the ref the hook owns.
    expect(ref.current).toBe(input)
  })

  it('FE-DOCPICK-002: hands the chosen files over and clears itself, so the same file can be picked twice', () => {
    const { input, onPicked } = setup()
    const file = new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })

    fireEvent.change(input, { target: { files: [file] } })

    expect(onPicked).toHaveBeenCalledWith([file])
    expect(input.value).toBe('')
  })

  it('FE-DOCPICK-003: a cancelled picker still reports, and the routing decides what nothing means', () => {
    const { input, onPicked } = setup()
    fireEvent.change(input, { target: { files: [] } })
    expect(onPicked).toHaveBeenCalledWith([])
  })
})
