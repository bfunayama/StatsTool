import { deepStrictEqual } from 'node:assert'
import { test } from 'node:test'
import { derivedSources, originalSources } from './variableSources.ts'

const variable = (name, changes = {}) => ({
  name, label: name, type: 'categorical', source_name: null,
  values: [], recode: null, ...changes,
})

test('raw variables have no sources and copies and recodes expose their source', () => {
  deepStrictEqual(derivedSources(variable('raw')), [])
  for (const recode of [null, {kind: 'band', bands: []}, {kind: 'binary'}, {kind: 'compact_select'}, {kind: 'code_one'}, {kind: 'code_any'}]) {
    deepStrictEqual(derivedSources(variable('derived', {source_name: 'raw', recode})), ['raw'])
  }
})

test('combined, count, rule and weight sources are deduplicated', () => {
  for (const kind of ['coalesce', 'count']) {
    deepStrictEqual(derivedSources(variable('derived', {recode: {kind, sources: ['a', 'b', 'a']}})), ['a', 'b'])
  }
  deepStrictEqual(derivedSources(variable('rules', {recode: {
    kind: 'rules', rules: [{conditions: [{variable: 'a'}, {variable: 'b'}]}, {conditions: [{variable: 'a'}]}],
  }})), ['a', 'b'])
  deepStrictEqual(derivedSources(variable('weight', {weighting: {rims: [{variables: ['a', 'b']}, {variables: ['a']}]}})), ['a', 'b'])
})

test('multi-column counts trace their original question without duplicates', () => {
  const variables = [
    variable('question'),
    variable('option1', {source_name: 'question'}),
    variable('option2', {source_name: 'question'}),
    variable('count', {recode: {kind: 'count', sources: ['option1', 'option2']}}),
  ]
  deepStrictEqual(originalSources(derivedSources(variables[3]), variables), ['question'])
})

test('segmentation uses recorded sources or a linked saved specification', () => {
  const segment = variable('segment', {recode: {kind: 'segment'}})
  const nodes = [{children: [{children: [], segmentation: {variable_name: 'segment', indicators: ['a', 'b']}}]}]
  deepStrictEqual(derivedSources(segment, nodes), ['a', 'b'])
  deepStrictEqual(derivedSources({...segment, recode: {kind: 'segment', sources: ['original']}}, nodes), ['original'])
  deepStrictEqual(derivedSources(segment), [])
})

test('original source tracing terminates for cycles and preserves missing names', () => {
  deepStrictEqual(originalSources(['a', 'missing'], [
    variable('a', {source_name: 'b'}), variable('b', {source_name: 'a'}),
  ]), ['missing'])
})
