import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText } from '../api'
import { positionKeyFromFen } from '../domain/chessLine'

/**
 * The user's comments on positions.
 *
 * `notes` maps a position key to its comment, loaded once and kept in step
 * with every save, so showing the comment for the position on the board, and
 * marking the commented moves of a game, need no request per move. A comment
 * belongs to the position, so it appears again however the position is reached.
 */
export function usePositionNotes() {
  const [notes, setNotes] = useState(() => new Map())
  const [error, setError] = useState('')
  const loaded = useRef(false)

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    api.get('/notes/all')
      .then((res) => {
        setNotes(new Map((res.data?.notes || []).map(item => [item.key, item.note])))
      })
      .catch(err => setError(errorText(err, 'Could not load your comments')))
  }, [])

  const noteFor = useCallback(fen => (fen ? notes.get(positionKeyFromFen(fen)) || '' : ''), [notes])

  /** Save the comment for the position `fen`; an empty one removes it. */
  const save = useCallback(async (fen, text) => {
    const key = positionKeyFromFen(fen)
    try {
      const res = await api.put('/notes', { fen, note: text })
      const saved = res.data?.note || ''
      setNotes((current) => {
        const next = new Map(current)
        if (saved) next.set(key, saved)
        else next.delete(key)
        return next
      })
      setError('')
      return true
    } catch (err) {
      setError(errorText(err, 'Could not save the comment'))
      return false
    }
  }, [])

  return { notes, noteFor, save, error }
}
