import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { playStepSound } from '../sounds'
import {
  TRAINER_STATUS,
  pickOpponentChild,
  trainerCurrentNode,
  trainerReducer,
} from '../domain/openingTrainer'
import { useDrillPersistence } from './useDrillPersistence'

export function useTrainingSession({ activeTab, repertoire, reloadRepertoire }) {
  const [trainer, dispatchTrainer] = useReducer(trainerReducer, null)
  const timer = useRef(null)
  // Results are saved per move, but the repertoire (≈600 KB of JSON for a big
  // one) is re-fetched once per finished line or exited run, not after every
  // move: nothing mid-line reads the refreshed counts.
  const drillWrite = useDrillPersistence()
  const trainerPath = useMemo(() => trainer?.currentPath || [], [trainer])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (!trainer || activeTab !== 'Practice' || drillWrite.pending || drillWrite.error) return
    window.clearTimeout(timer.current)
    if (trainer.status !== TRAINER_STATUS.AUTOPLAYING_OPPONENT) return
    timer.current = window.setTimeout(() => {
      const child = pickOpponentChild(trainerCurrentNode(trainer), trainer.remaining)
      if (!child) return
      playStepSound(child.san)
      dispatchTrainer({ type: 'opponentMove', childPath: child.path, san: child.san })
    }, 420)
  }, [trainer, activeTab, drillWrite.pending, drillWrite.error])

  useEffect(() => {
    if (!trainer || trainer.status !== TRAINER_STATUS.LINE_COMPLETE || trainer.lineRecorded
        || drillWrite.pending || drillWrite.error) return
    const key = trainerPath.join(' ')
    const branch = (repertoire?.branches || []).find(item => item.moves_san === key)
    if (branch) {
      drillWrite.send({
        solved: trainer.lineMisses.length === 0,
        source: 'practice',
        branch_id: branch.id,
        path_san: key,
      }, () => {
        dispatchTrainer({ type: 'markLineRecorded' })
        reloadRepertoire?.()
      })
    } else {
      dispatchTrainer({ type: 'markLineRecorded' })
      reloadRepertoire?.()
    }
  }, [trainer, trainerPath, repertoire, drillWrite, reloadRepertoire])

  const stopTrainer = useCallback(() => {
    window.clearTimeout(timer.current)
    dispatchTrainer({ type: 'stop' })
    drillWrite.clear()
    // Misses from a line abandoned midway are saved but not yet reflected.
    reloadRepertoire?.()
  }, [drillWrite, reloadRepertoire])

  const clearTimer = useCallback(() => window.clearTimeout(timer.current), [])

  return {
    trainer,
    trainerPath,
    dispatchTrainer,
    drillWrite,
    stopTrainer,
    clearTimer,
  }
}
