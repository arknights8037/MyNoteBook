import { computed, onBeforeUnmount, ref, type Ref } from 'vue'

type BrowserPointerEvent = InstanceType<typeof globalThis.PointerEvent>
type BrowserHTMLElement = InstanceType<typeof globalThis.HTMLElement>
type ResizeDirection = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface FloatingDragState {
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  width: number
  height: number
}

interface FloatingResizeState {
  pointerId: number
  direction: ResizeDirection
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  startWidth: number
  startHeight: number
}

export function useFloatingAiChatPanel(workspace: Ref<boolean>, docked: Ref<boolean>) {
  const panelElement = ref<BrowserHTMLElement | null>(null)
  const floatingPosition = ref<{ x: number; y: number } | null>(null)
  const floatingSize = ref<{ width: number; height: number } | null>(null)
  const resizeDirections: ResizeDirection[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']
  let floatingDragState: FloatingDragState | null = null
  let floatingResizeState: FloatingResizeState | null = null

  const floatingWindowStyle = computed(() => {
    if (workspace.value || docked.value) return undefined
    return {
      ...(floatingPosition.value
        ? {
            left: `${floatingPosition.value.x}px`,
            top: `${floatingPosition.value.y}px`,
            right: 'auto',
            bottom: 'auto',
          }
        : {}),
      ...(floatingSize.value
        ? {
            width: `${floatingSize.value.width}px`,
            height: `${floatingSize.value.height}px`,
          }
        : {}),
    }
  })

  function startWindowDrag(event: BrowserPointerEvent): void {
    if (workspace.value || docked.value || event.button !== 0) return
    const target = event.target
    if (target instanceof globalThis.Element && target.closest('button, input, textarea, select')) {
      return
    }
    const rect = panelElement.value?.getBoundingClientRect()
    if (!rect) return
    event.preventDefault()
    floatingPosition.value = { x: rect.left, y: rect.top }
    floatingDragState = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: rect.left,
      startY: rect.top,
      width: rect.width,
      height: rect.height,
    }
    ;(event.currentTarget as BrowserHTMLElement | null)?.setPointerCapture?.(event.pointerId)
    globalThis.window.addEventListener('pointermove', dragFloatingWindow)
    globalThis.window.addEventListener('pointerup', stopWindowDrag)
  }

  function dragFloatingWindow(event: BrowserPointerEvent): void {
    if (!floatingDragState || event.pointerId !== floatingDragState.pointerId) return
    floatingPosition.value = {
      x: clamp(
        floatingDragState.startX + event.clientX - floatingDragState.startClientX,
        8,
        Math.max(8, globalThis.window.innerWidth - floatingDragState.width - 8),
      ),
      y: clamp(
        floatingDragState.startY + event.clientY - floatingDragState.startClientY,
        8,
        Math.max(8, globalThis.window.innerHeight - floatingDragState.height - 8),
      ),
    }
  }

  function stopWindowDrag(): void {
    floatingDragState = null
    globalThis.window.removeEventListener('pointermove', dragFloatingWindow)
    globalThis.window.removeEventListener('pointerup', stopWindowDrag)
  }

  function startWindowResize(direction: ResizeDirection, event: BrowserPointerEvent): void {
    if (workspace.value || docked.value || event.button !== 0) return
    const rect = panelElement.value?.getBoundingClientRect()
    if (!rect) return
    event.preventDefault()
    event.stopPropagation()
    floatingPosition.value = { x: rect.left, y: rect.top }
    floatingSize.value = { width: rect.width, height: rect.height }
    floatingResizeState = {
      pointerId: event.pointerId,
      direction,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: rect.left,
      startY: rect.top,
      startWidth: rect.width,
      startHeight: rect.height,
    }
    ;(event.currentTarget as BrowserHTMLElement | null)?.setPointerCapture?.(event.pointerId)
    globalThis.window.addEventListener('pointermove', resizeFloatingWindow)
    globalThis.window.addEventListener('pointerup', stopWindowResize)
  }

  function resizeFloatingWindow(event: BrowserPointerEvent): void {
    if (!floatingResizeState || event.pointerId !== floatingResizeState.pointerId) return
    const deltaX = event.clientX - floatingResizeState.startClientX
    const deltaY = event.clientY - floatingResizeState.startClientY
    const minWidth = Math.min(340, Math.max(280, globalThis.window.innerWidth - 32))
    const minHeight = Math.min(360, Math.max(260, globalThis.window.innerHeight - 32))
    const maxWidth = Math.max(minWidth, globalThis.window.innerWidth - 16)
    const maxHeight = Math.max(minHeight, globalThis.window.innerHeight - 16)
    let nextX = floatingResizeState.startX
    let nextY = floatingResizeState.startY
    let nextWidth = floatingResizeState.startWidth
    let nextHeight = floatingResizeState.startHeight

    if (floatingResizeState.direction.includes('e')) nextWidth += deltaX
    if (floatingResizeState.direction.includes('s')) nextHeight += deltaY
    if (floatingResizeState.direction.includes('w')) nextWidth -= deltaX
    if (floatingResizeState.direction.includes('n')) nextHeight -= deltaY
    nextWidth = clamp(nextWidth, minWidth, maxWidth)
    nextHeight = clamp(nextHeight, minHeight, maxHeight)
    if (floatingResizeState.direction.includes('w')) {
      nextX = floatingResizeState.startX + floatingResizeState.startWidth - nextWidth
    }
    if (floatingResizeState.direction.includes('n')) {
      nextY = floatingResizeState.startY + floatingResizeState.startHeight - nextHeight
    }
    floatingPosition.value = {
      x: clamp(nextX, 8, Math.max(8, globalThis.window.innerWidth - nextWidth - 8)),
      y: clamp(nextY, 8, Math.max(8, globalThis.window.innerHeight - nextHeight - 8)),
    }
    floatingSize.value = { width: nextWidth, height: nextHeight }
  }

  function stopWindowResize(): void {
    floatingResizeState = null
    globalThis.window.removeEventListener('pointermove', resizeFloatingWindow)
    globalThis.window.removeEventListener('pointerup', stopWindowResize)
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
  }

  onBeforeUnmount(() => {
    stopWindowDrag()
    stopWindowResize()
  })

  return {
    floatingWindowStyle,
    panelElement,
    resizeDirections,
    startWindowDrag,
    startWindowResize,
  }
}
