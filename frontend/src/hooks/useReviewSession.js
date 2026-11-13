import { useCallback, useReducer, useRef, useState } from 'react'
import { api } from '../api'
import { drillEventKey } from './useDrillPersistence'
import { currentReviewItem, reviewReducer } from '../domain/reviewSession'

const EMPTY_WRITE = { pending: false, error: '', attempt: null }

export function useReviewSession(reloadRepertoire) {
  const [review, dispatchReview] = useReducer(reviewReducer, null)
  const [reviewWrite, setReviewWrite] = useState(EMPTY_WRITE)
  const writeGeneration = useRef(0)
  const writePending = useRef(false)
  const reviewItem = currentReviewItem(review)

  const recordReview = useCallback(async (
    item,
    solved,
    playedSan,
    eventKey = drillEventKey(),
  ) => {
    if (writePending.current) return false
    writePending.current = true
    const generation = writeGeneration.current
    const attempt = { item, solved, playedSan, eventKey }
    setReviewWrite({ pending: true, error: '', attempt })
    try {
      await api.post('/repertoire/drill-attempts', {
        event_key: eventKey,
        solved,
        source: 'review',
        node_id: item.id,
        expected_san: item.san,
        played_san: playedSan,
        path_san: item.path.join(' '),
      })
      // Resetting or replacing a review session invalidates callbacks from the
      // previous session, even if its HTTP request still succeeds on the server.
      if (generation !== writeGeneration.current) return false
      await reloadRepertoire()
      if (generation !== writeGeneration.current) return false
      setReviewWrite(EMPTY_WRITE)
      return true
    } catch {
      if (generation !== writeGeneration.current) return false
      setReviewWrite({
        pending: false,
        error: 'Could not save this review result. Retry before continuing.',
        attempt,
      })
      return false
    } finally {
      if (generation === writeGeneration.current) writePending.current = false
    }
  }, [reloadRepertoire])

  const retryReviewWrite = useCallback(() => {
    const attempt = reviewWrite.attempt
    if (!attempt || reviewWrite.pending) return
    recordReview(attempt.item, attempt.solved, attempt.playedSan, attempt.eventKey)
  }, [recordReview, reviewWrite])

  const resetReviewWrite = useCallback(() => {
    writeGeneration.current += 1
    writePending.current = false
    setReviewWrite(EMPTY_WRITE)
  }, [])

  return {
    review,
    reviewItem,
    reviewWrite,
    dispatchReview,
    recordReview,
    retryReviewWrite,
    resetReviewWrite,
  }
}
