import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * Below 640px the modal is restyled as a drawer from index.css while its box is
 * built in Modal.tsx, so the two only agree by convention. jsdom applies neither
 * the media query nor the stylesheet, which is exactly the interaction that
 * broke here — so this reads the real file.
 */
describe('mobile modal drawer css', () => {
  // Vitest runs with the client package as its root, so cwd is stable here.
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
  const drawerRule = (): string => {
    const at = css.indexOf('@media (max-width: 639px)', css.indexOf('trek-drawer-enter'))
    expect(at, 'the drawer media query is missing from index.css').toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}\n}', at) + 3)
  }

  it('FE-COMP-MODALDRAWER-001: the sheet keeps its rounded bottom, because it never reaches the screen edge', () => {
    // The corners were squared for a sheet docked to the bottom of the screen.
    // The backdrop reserves room for the bottom nav, so it docks to nothing: it
    // floated over a visible gap with a squared edge, round on top and cut off
    // underneath.
    expect(drawerRule()).not.toMatch(/border-bottom-(left|right)-radius:\s*0/)
  })

  it('FE-COMP-MODALDRAWER-002: it still arrives from the bottom, sitting low in the frame', () => {
    expect(drawerRule()).toMatch(/animation:\s*trek-drawer-enter/)
    expect(drawerRule()).toMatch(/align-self:\s*flex-end/)
  })
})
