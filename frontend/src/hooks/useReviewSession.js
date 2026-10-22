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
    matched = null,
  ) => {
    const attempt = { item, solved, playedSan, eventKey, matched }
    setReviewWrite({ pending: true, error: '', attempt })
    try {
      // Credit the reply the player actually made. One card can hold several
      // saved replies, so answering with the transposed one must advance that
      // node's history, not the queue item's representative node.
      await api.post('/repertoire/drill-attempts', {
        event_key: eventKey,
        solved,
        source: 'review',
        node_id: matched?.node_id || item.id,
        expected_san: matched?.san || item.san,
        played_san: playedSan,
        path_san: matched?.path_san || item.path.join(' '),
      })
      // The answer is saved; unblock "Next" now. The refresh only updates the
      // due badge and list, and used to hold every card for a full tree fetch.
      setReviewWrite(EMPTY_WRITE)
      reloadRepertoire()
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
    recordReview(
      attempt.item, attempt.solved, attempt.playedSan, attempt.eventKey, attempt.matched,
    )
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
