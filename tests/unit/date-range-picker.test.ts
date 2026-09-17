import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const component = readFileSync(join(ROOT, 'resources/components/DateRangePicker.stx'), 'utf8')
const analytics = readFileSync(join(ROOT, 'resources/views/analytics.stx'), 'utf8')

// The date math ships inside the component's client script; the #region markers
// fence off the part that touches no runtime, and this evaluates exactly that
// text, so the tests run against the code the page runs.
const pureSlice = component.match(/\/\/ #region pure\n([\s\S]*?)\n\/\/ #endregion pure/)?.[1] ?? ''
const pure = new Function(`${pureSlice}\nreturn { pickYmd, pickShift, pickShiftMonth, pickGrid, pickOrder, pickPreset, pickQuery }`)() as Record<string, (...a: any[]) => any>

describe('loghq date range picker: grid + day math', () => {
  test('six weeks starting on the Sunday on or before the 1st', () => {
    const cells = pure.pickGrid('2026-06', '2026-09-16')
    expect(cells).toHaveLength(42)
    expect(cells[0].ymd).toBe('2026-05-31')
    expect(cells.filter((c: any) => c.inMonth)).toHaveLength(30)
  })
  test('leap February and future-day flag', () => {
    expect(pure.pickGrid('2028-02', '2028-09-16').filter((c: any) => c.inMonth)).toHaveLength(29)
    const cells = pure.pickGrid('2026-09', '2026-09-16')
    expect(cells.find((c: any) => c.ymd === '2026-09-17').future).toBe(true)
    expect(cells.find((c: any) => c.ymd === '2026-09-16').future).toBe(false)
  })
  test('day shifts survive DST and year ends', () => {
    expect(pure.pickShift('2026-03-08', 1)).toBe('2026-03-09')
    expect(pure.pickShift('2026-11-01', 1)).toBe('2026-11-02')
    expect(pure.pickShift('2026-01-01', -1)).toBe('2025-12-31')
    expect(pure.pickShiftMonth('2026-12', 1)).toBe('2027-01')
  })
})

describe('loghq date range picker: presets match loghq vocab', () => {
  const today = '2026-09-16'
  test('loghq native spans go out as ?range=', () => {
    for (const key of ['7d', '30d', '90d', '180d'])
      expect(pure.pickPreset(key, today)).toEqual({ range: key })
  })
  test('loghq does not offer 24h, 1y or all', () => {
    for (const key of ['24h', '1y', 'all'])
      expect(pure.pickPreset(key, today)).toBeNull()
    expect(component).not.toContain("pickApply('all')")
    expect(component).not.toContain("pickApply('1y')")
    expect(component).toContain("pickApply('180d')")
  })
  test('calendar presets resolve to local day bounds', () => {
    expect(pure.pickPreset('today', today)).toEqual({ from: '2026-09-16', to: '2026-09-16' })
    expect(pure.pickPreset('last-month', today)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(pure.pickPreset('this-year', today)).toEqual({ from: '2026-01-01', to: '2026-09-16' })
  })
})

describe('loghq date range picker: URL + wiring', () => {
  test('a custom span keeps project and drops the preset', () => {
    const next = new URLSearchParams(pure.pickQuery('?project=p1&range=90d', { from: '2026-09-01', to: '2026-09-16' }))
    expect(next.get('project')).toBe('p1')
    expect(next.get('from')).toBe('2026-09-01')
    expect(next.get('to')).toBe('2026-09-16')
    expect(next.has('range')).toBe(false)
  })
  test('a preset drops any custom span', () => {
    const next = new URLSearchParams(pure.pickQuery('?from=2026-09-01&to=2026-09-16', { range: '30d' }))
    expect(next.get('range')).toBe('30d')
    expect(next.has('from')).toBe(false)
  })
  test('analytics.stx mounts the picker, reads custom bounds, and neutralizes the pills under a custom range', () => {
    expect(analytics).toContain('<DateRangePicker :summary="rangeLabel" :active="isCustom" />')
    expect(analytics).toContain('const isCustom = isDay(qFrom) && isDay(qTo)')
    expect(analytics).toContain('active: !isCustom && r.key === activeRange.key')
    expect(analytics).toMatch(/if \(isCustom\) \{\s*fromDay = customFrom\s*toDay = customTo/)
  })
})
