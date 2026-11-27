import type { CrosstabNode, Variable } from '../api'

export function derivedSources(variable: Variable, nodes: CrosstabNode[] = []): string[] {
  const sources = variable.source_name ? [variable.source_name] : []
  const recode = variable.recode
  if (recode?.kind === 'coalesce' || recode?.kind === 'count') {
    sources.push(...recode.sources)
  } else if (recode?.kind === 'rules') {
    sources.push(...recode.rules.flatMap((rule) => rule.conditions.map((c) => c.variable)))
  } else if (recode?.kind === 'segment') {
    sources.push(...(recode.sources ?? []))
    if (sources.length === 0) {
      const find = (items: CrosstabNode[]): string[] => {
        for (const node of items) {
          if (node.segmentation?.variable_name === variable.name) {
            return node.segmentation.indicators
          }
          const found = find(node.children)
          if (found.length > 0) return found
        }
        return []
      }
      sources.push(...find(nodes))
    }
  }
  sources.push(...(variable.weighting?.rims.flatMap((rim) => rim.variables) ?? []))
  return [...new Set(sources)]
}

export function originalSources(
  sources: string[],
  variables: Variable[],
  nodes: CrosstabNode[] = [],
): string[] {
  const originals = new Set<string>()
  const visit = (name: string, path: Set<string>) => {
    if (path.has(name)) return
    const variable = variables.find((v) => v.name === name)
    const parents = variable ? derivedSources(variable, nodes) : []
    if (parents.length === 0) {
      originals.add(name)
      return
    }
    const next = new Set(path).add(name)
    for (const parent of parents) visit(parent, next)
  }
  for (const source of sources) visit(source, new Set())
  return [...originals]
}
