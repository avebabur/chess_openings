import { useCallback, useEffect, useRef, useState } from 'react'
import { playStepSound } from '../sounds'
import { applySanMove, boardFromPath } from '../domain/chessLine'

export function useOpeningNavigation() {
  const [line, setLine] = useState({ path: [], future: [] })
  const [flipped, setFlipped] = useState(false)
  const lineRef = useRef(line)
  const { path, future } = line

  useEffect(() => { lineRef.current = line }, [line])

  const pushMove = useCallback((san) => {
    setLine(({ path: currentPath, future: currentFuture }) => ({
      path: [...currentPath, san],
      future: currentFuture[0] === san ? currentFuture.slice(1) : [],
    }))
  }, [])

  const jumpToPath = useCallback((newPath) => {
    setLine({ path: newPath, future: [] })
  }, [])

  const goBack = useCallback(() => {
    const current = lineRef.current
    if (!current.path.length) return
    playStepSound(current.path[current.path.length - 1])
    setLine(({ path: currentPath, future: currentFuture }) => (
      currentPath.length
        ? {
          path: currentPath.slice(0, -1),
          future: [currentPath[currentPath.length - 1], ...currentFuture],
        }
        : { path: currentPath, future: currentFuture }
    ))
  }, [])

  const goForward = useCallback(() => {
    const current = lineRef.current
    if (!current.future.length) return
    playStepSound(current.future[0])
    setLine(({ path: currentPath, future: currentFuture }) => {
      if (!currentFuture.length) return { path: currentPath, future: currentFuture }
      const next = currentFuture[0]
      if (!applySanMove(boardFromPath(currentPath).fen, next)) {
        return { path: currentPath, future: [] }
      }
      return { path: [...currentPath, next], future: currentFuture.slice(1) }
    })
  }, [])

  const goStart = useCallback(() => {
    setLine(({ path: currentPath, future: currentFuture }) => (
      currentPath.length
        ? { path: [], future: [...currentPath, ...currentFuture] }
        : { path: currentPath, future: currentFuture }
    ))
  }, [])

  const goEnd = useCallback(() => {
    setLine(({ path: currentPath, future: currentFuture }) => (
      currentFuture.length
        ? { path: [...currentPath, ...currentFuture], future: [] }
        : { path: currentPath, future: currentFuture }
    ))
  }, [])

  const flip = useCallback(() => setFlipped(value => !value), [])

  return {
    line,
    path,
    future,
    setLine,
    pushMove,
    jumpToPath,
    goBack,
    goForward,
    goStart,
    goEnd,
    flipped,
    setFlipped,
    flip,
  }
}
