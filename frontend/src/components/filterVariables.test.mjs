import { deepStrictEqual } from 'node:assert'
import { test } from 'node:test'
import { pickAnyFilterGroups } from './filterVariables.ts'

test('Pick Any options are grouped by question and hidden options stay hidden', () => {
  const meta = {
    variables: [{name: 'none'}, {name: 'dental'}, {name: 'hidden', hidden: true}],
    questions: [
      {id: 'claims', kind: 'multi', label: 'Claims', items: [
        {column: 'none', label: 'None of the above'},
        {column: 'dental', label: 'Dental'},
        {column: 'hidden', label: 'Hidden'},
        {column: 'deleted', label: 'Deleted'},
      ]},
      {id: 'grid', kind: 'grid', items: [{column: 'dental'}]},
    ],
  }
  deepStrictEqual(pickAnyFilterGroups(meta, '').map((g) => g.items.map((i) => i.column)), [['none', 'dental']])
  deepStrictEqual(pickAnyFilterGroups(meta, 'hidden').map((g) => g.items.map((i) => i.column)), [['none', 'dental', 'hidden']])
})
