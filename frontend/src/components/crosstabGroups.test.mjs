import { deepStrictEqual, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { convertNetToMerge, groupSelectedHeaders } from './crosstabGroups.ts'

const first = { id: 'a', label: 'A / B', members: ['A', 'B'], mode: 'merge' }
const second = { id: 'b', label: 'C / D', members: ['C', 'D'], mode: 'merge' }

test('merge expands groups, removes them, and keeps unrelated groups', () => {
  const other = { id: 'other', label: 'E / F', members: ['E', 'F'], mode: 'merge' }
  deepStrictEqual(groupSelectedHeaders([first, second, other], ['A / B', 'C / D', 'G'], 'merge', 'new'), [
    other,
    { id: 'new', label: 'A / B / C / D / G', members: ['A', 'B', 'C', 'D', 'G'], mode: 'merge' },
  ])
})

test('NET expands members while retaining existing groups', () => {
  const net = { id: 'net', label: 'NET', members: ['X', 'Y'], mode: 'net' }
  deepStrictEqual(groupSelectedHeaders([first, net], ['A / B', 'C'], 'net', 'new'), [
    first, net,
    { id: 'new', label: 'NET 2', members: ['A', 'B', 'C'], mode: 'net' },
  ])
})

test('merge of an overlapping NET absorbs the whole existing merge', () => {
  const net = { id: 'net', label: 'NET', members: ['A', 'C'], mode: 'net' }
  deepStrictEqual(groupSelectedHeaders([first, net], ['NET', 'D'], 'merge', 'new'), [
    { id: 'new', label: 'A / C / D / B', members: ['A', 'C', 'D', 'B'], mode: 'merge' },
  ])
})

test('overlapping selections are deduplicated and single headers are ignored', () => {
  const net = { id: 'net', label: 'NET', members: ['A', 'C'], mode: 'net' }
  deepStrictEqual(groupSelectedHeaders([first, net], ['A / B', 'NET'], 'net', 'new')[2].members, ['A', 'B', 'C'])
  const groups = [first]
  strictEqual(groupSelectedHeaders(groups, ['A / B'], 'merge', 'new'), groups)
})

test('converting a NET to a merge absorbs overlapping merged groups', () => {
  const net = { id: 'net', label: 'NET', members: ['A', 'B', 'C'], mode: 'net' }
  deepStrictEqual(convertNetToMerge([first, net], net), [
    { ...net, label: 'A / B / C', mode: 'merge' },
  ])
})
