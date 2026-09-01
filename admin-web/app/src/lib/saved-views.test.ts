import { beforeEach, describe, expect, it } from 'vitest'
import { deleteView, loadSavedViews, saveView } from './saved-views'

beforeEach(() => {
  localStorage.clear()
})

describe('saved-views', () => {
  it('returns empty when no views are stored', () => {
    expect(loadSavedViews('orders')).toEqual([])
  })

  it('saveView persists a view and loadSavedViews retrieves it', () => {
    saveView('orders', {
      name: 'High-value',
      sortKey: 'total',
      sortDir: 'desc',
      visibleKeys: ['no', 'status', 'total'],
      createdAt: '2026-08-29T10:00:00.000Z',
    })

    const views = loadSavedViews('orders')
    expect(views).toHaveLength(1)
    expect(views[0].name).toBe('High-value')
    expect(views[0].sortKey).toBe('total')
    expect(views[0].sortDir).toBe('desc')
    expect(views[0].visibleKeys).toEqual(['no', 'status', 'total'])
  })

  it('saveView with same name overwrites the existing view', () => {
    saveView('orders', {
      name: 'My view',
      sortKey: 'no',
      sortDir: 'asc',
      visibleKeys: null,
      createdAt: '2026-01-01',
    })
    saveView('orders', {
      name: 'My view',
      sortKey: 'created',
      sortDir: 'desc',
      visibleKeys: ['no'],
      createdAt: '2026-08-29',
    })

    const views = loadSavedViews('orders')
    expect(views).toHaveLength(1)
    expect(views[0].sortKey).toBe('created')
  })

  it('deleteView removes a view by name', () => {
    saveView('orders', { name: 'A', sortKey: null, sortDir: 'asc', visibleKeys: null, createdAt: '' })
    saveView('orders', { name: 'B', sortKey: null, sortDir: 'asc', visibleKeys: null, createdAt: '' })

    deleteView('orders', 'A')
    const views = loadSavedViews('orders')
    expect(views).toHaveLength(1)
    expect(views[0].name).toBe('B')
  })

  it('views are scoped per tableId', () => {
    saveView('orders', { name: 'A', sortKey: null, sortDir: 'asc', visibleKeys: null, createdAt: '' })
    saveView('riders', { name: 'B', sortKey: null, sortDir: 'asc', visibleKeys: null, createdAt: '' })

    expect(loadSavedViews('orders')).toHaveLength(1)
    expect(loadSavedViews('riders')).toHaveLength(1)
    expect(loadSavedViews('orders')[0].name).toBe('A')
    expect(loadSavedViews('riders')[0].name).toBe('B')
  })

  it('ignores corrupt data in localStorage', () => {
    localStorage.setItem('hudumika.views.orders', 'not-json{')
    expect(loadSavedViews('orders')).toEqual([])
  })
})
