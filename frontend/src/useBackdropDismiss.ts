import { useRef, type MouseEvent } from 'react'

// Dismiss a modal only when the click both starts and ends on the backdrop, so a
// text-selection drag that merely releases over the backdrop doesn't close it.
export function useBackdropDismiss() {
  const downOnBackdrop = useRef(false)
  return (onClose: () => void) => ({
    onMouseDown: (e: MouseEvent) => {
      downOnBackdrop.current = e.target === e.currentTarget
    },
    onClick: (e: MouseEvent) => {
      if (e.target === e.currentTarget && downOnBackdrop.current) onClose()
    },
  })
}
