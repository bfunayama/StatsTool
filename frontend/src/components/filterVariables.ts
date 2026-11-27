import type { DatasetMeta } from '../api'

export function pickAnyFilterGroups(meta: DatasetMeta, current: string) {
  return meta.questions
    .filter((question) => question.kind === 'multi')
    .map((question) => ({
      question,
      items: question.items.filter((item) =>
        meta.variables.some((variable) =>
          variable.name === item.column && (!variable.hidden || variable.name === current),
        ),
      ),
    }))
    .filter((group) => group.items.length > 0)
}
