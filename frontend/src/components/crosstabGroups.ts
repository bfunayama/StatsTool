import type { CrosstabGroup } from '../api'

function absorbOverlappingMerges(
  groups: CrosstabGroup[],
  members: Set<string>,
  absorbed: Set<string>,
) {
  let changed = true
  while (changed) {
    changed = false
    for (const group of groups) {
      if (group.mode !== 'merge' || absorbed.has(group.id)) continue
      if (!group.members.some((member) => members.has(member))) continue
      absorbed.add(group.id)
      for (const member of group.members) members.add(member)
      changed = true
    }
  }
}

export function groupSelectedHeaders(
  groups: CrosstabGroup[],
  headers: string[],
  mode: 'net' | 'merge',
  id: string,
): CrosstabGroup[] {
  const selected = [...new Set(headers)]
  if (selected.length < 2) return groups

  const selectedGroups = groups.filter((group) => selected.includes(group.label))
  const members = new Set(
    selected.flatMap((header) => {
      const group = selectedGroups.find((item) => item.label === header)
      return group ? group.members : [header]
    }),
  )

  // A merge must not overlap another merge: the backend assigns each member
  // to its first merge. Absorb overlapping merges in their entirety.
  const absorbed = new Set(selectedGroups.map((group) => group.id))
  if (mode === 'merge') absorbOverlappingMerges(groups, members, absorbed)

  const remaining = mode === 'merge'
    ? groups.filter((group) => !absorbed.has(group.id))
    : groups
  const orderedMembers = [...members]
  const base = mode === 'net' ? 'NET' : orderedMembers.join(' / ')
  const labels = new Set(remaining.map((group) => group.label))
  let label = base
  let suffix = 2
  while (labels.has(label)) label = `${base} ${suffix++}`
  return [...remaining, { id, label, members: orderedMembers, mode }]
}

export function convertNetToMerge(
  groups: CrosstabGroup[],
  group: CrosstabGroup,
): CrosstabGroup[] {
  const members = new Set(group.members)
  const absorbed = new Set([group.id])
  absorbOverlappingMerges(groups, members, absorbed)
  const orderedMembers = [...members]
  const remaining = groups.filter((item) => !absorbed.has(item.id))
  const base = orderedMembers.join(' / ')
  const labels = new Set(remaining.map((item) => item.label))
  let label = group.label === 'NET' ? base : group.label
  let suffix = 2
  if (group.label === 'NET') {
    while (labels.has(label)) label = `${base} ${suffix++}`
  }
  return [...remaining, { ...group, label, members: orderedMembers, mode: 'merge' }]
}
