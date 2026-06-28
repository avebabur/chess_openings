import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOpeningsKeyboard } from './useOpeningsKeyboard'

function Harness({ engineEnabled = true, deepen, shallow, freeze, flip }) {
  useOpeningsKeyboard({ engineEnabled, deepen, shallow, freeze, flip })
  return <input aria-label="Editor" />
}

afterEach(cleanup)

describe('useOpeningsKeyboard depth bindings', () => {
  it('maps both shifted and unshifted depth keys', () => {
    const deepen = vi.fn()
    const shallow = vi.fn()
    render(<Harness deepen={deepen} shallow={shallow} />)

    fireEvent.keyDown(window, { key: '=' })
    fireEvent.keyDown(window, { key: '+' })
    fireEvent.keyDown(window, { key: '-' })
    fireEvent.keyDown(window, { key: '_' })

    expect(deepen).toHaveBeenCalledTimes(2)
    expect(shallow).toHaveBeenCalledTimes(2)
  })

  it('maps 0 to freeze when the engine is enabled', () => {
    const freeze = vi.fn()
    render(<Harness freeze={freeze} />)

    fireEvent.keyDown(window, { key: '0' })

    expect(freeze).toHaveBeenCalledTimes(1)
  })

  it('ignores modifier combos so browser shortcuts keep working', () => {
    const deepen = vi.fn()
    const shallow = vi.fn()
    const freeze = vi.fn()
    const flip = vi.fn()
    render(<Harness deepen={deepen} shallow={shallow} freeze={freeze} flip={flip} />)

    fireEvent.keyDown(window, { key: 'f', metaKey: true })   // ⌘F find
    fireEvent.keyDown(window, { key: '=', metaKey: true })   // ⌘= zoom in
    fireEvent.keyDown(window, { key: '-', ctrlKey: true })   // ⌃- zoom out
    fireEvent.keyDown(window, { key: '0', metaKey: true })   // ⌘0 reset zoom

    expect(flip).not.toHaveBeenCalled()
    expect(deepen).not.toHaveBeenCalled()
    expect(shallow).not.toHaveBeenCalled()
    expect(freeze).not.toHaveBeenCalled()
  })

  it('does not run shortcuts inside an editor or while disabled', () => {
    const deepen = vi.fn()
    const shallow = vi.fn()
    const { getByLabelText, rerender } = render(
      <Harness deepen={deepen} shallow={shallow} />,
    )

    fireEvent.keyDown(getByLabelText('Editor'), { key: '=' })
    rerender(<Harness engineEnabled={false} deepen={deepen} shallow={shallow} />)
    fireEvent.keyDown(window, { key: '-' })

    expect(deepen).not.toHaveBeenCalled()
    expect(shallow).not.toHaveBeenCalled()
  })
})
