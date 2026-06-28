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
  const drillWrite = useDrillPersistence(reloadRepertoire)
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
      }, () => dispatchTrainer({ type: 'markLineRecorded' }))
    } else {
      dispatchTrainer({ type: 'markLineRecorded' })
    }
  }, [trainer, trainerPath, repertoire, drillWrite])

  const stopTrainer = useCallback(() => {
    window.clearTimeout(timer.current)
    dispatchTrainer({ type: 'stop' })
    drillWrite.clear()
  }, [drillWrite])

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
