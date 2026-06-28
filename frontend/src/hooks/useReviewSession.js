import { useCallback, useReducer, useState } from 'react'
import { api } from '../api'
import { drillEventKey } from './useDrillPersistence'
import { currentReviewItem, reviewReducer } from '../domain/reviewSession'

const EMPTY_WRITE = { pending: false, error: '', attempt: null }

export function useReviewSession(reloadRepertoire) {
  const [review, dispatchReview] = useReducer(reviewReducer, null)
  const [reviewWrite, setReviewWrite] = useState(EMPTY_WRITE)
  const reviewItem = currentReviewItem(review)

  const recordReview = useCallback(async (
    item,
    solved,
    playedSan,
    eventKey = drillEventKey(),
  ) => {
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
      await reloadRepertoire()
      setReviewWrite(EMPTY_WRITE)
      return true
    } catch {
      setReviewWrite({
        pending: false,
        error: 'Could not save this review result. Retry before continuing.',
        attempt,
      })
      return false
    }
  }, [reloadRepertoire])

  const retryReviewWrite = useCallback(() => {
    const attempt = reviewWrite.attempt
    if (!attempt || reviewWrite.pending) return
    recordReview(attempt.item, attempt.solved, attempt.playedSan, attempt.eventKey)
  }, [recordReview, reviewWrite])

  const resetReviewWrite = useCallback(() => setReviewWrite(EMPTY_WRITE), [])

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
