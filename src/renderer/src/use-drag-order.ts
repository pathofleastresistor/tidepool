import { useRef, useState } from 'react'

function move(ids: string[], id: string, before: string): string[] {
  const from = ids.indexOf(id)
  const to = ids.indexOf(before)
  if (from === -1 || to === -1 || from === to) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/**
 * Drag-to-reorder for a list of items with ids. While dragging, the order shown follows the
 * pointer; `onReorder` gets the new order once, when the drag ends. Each list has its own hook,
 * so dragging between lists does nothing.
 */
export function useDragOrder(
  ids: string[],
  onReorder: (ids: string[]) => void
): {
  order: string[]
  isDragging: (id: string) => boolean
  dragProps: (id: string, data?: string) => React.HTMLAttributes<HTMLElement> & { draggable: boolean }
} {
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const dragId = useRef<string | null>(null)

  return {
    order: dragOrder ?? ids,
    isDragging: (id) => dragOrder !== null && dragId.current === id,
    dragProps: (id, data) => ({
      draggable: true,
      onDragStart: (e) => {
        dragId.current = id
        e.dataTransfer.effectAllowed = 'move'
        if (data) e.dataTransfer.setData('text/plain', data)
        setDragOrder(ids)
      },
      onDragOver: (e) => {
        if (!dragId.current) return
        e.preventDefault()
        if (dragId.current !== id) setDragOrder((order) => order && move(order, dragId.current!, id))
      },
      onDrop: (e) => e.preventDefault(),
      onDragEnd: () => {
        if (dragOrder && dragOrder.join() !== ids.join()) onReorder(dragOrder)
        dragId.current = null
        setDragOrder(null)
      }
    })
  }
}
