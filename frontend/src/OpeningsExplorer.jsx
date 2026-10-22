/* eslint-disable react-hooks/set-state-in-effect, react-hooks/preserve-manual-memoization */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { playIllegalSound, playStepSound } from './sounds'
import { useBoardSize } from './hooks/useBoardSize'
import { useOpeningsKeyboard } from './hooks/useOpeningsKeyboard'
import { useOpeningTree } from './hooks/useOpeningTree'
import { useOpenings } from './hooks/useOpenings'
import { useGames } from './hooks/useGames'
import { usePositionEval } from './hooks/usePositionEval'
import { useOpeningExplorer } from './hooks/useOpeningExplorer'
import { useExplorerFilters } from './hooks/useExplorerFilters'
import { useRepertoire } from './hooks/useRepertoire'
import { useAccountManager } from './hooks/useAccountManager'
import { useOpeningNavigation } from './hooks/useOpeningNavigation'
import { useTrainingSession } from './hooks/useTrainingSession'
import { useReviewSession } from './hooks/useReviewSession'
import {
  START_FEN,
  applySanMove,
  boardFromPath,
  findNodeByPath,
  isExpectedMove,
  matchExpectedMove,
  legalDests,
  makeMove,
  needsPromotion,
  pieceAt,
  sansFromPgn,
  sideToMove,
  splitSanLine,
  indexNodesByEpdBefore,
  positionKeyFromFen,
  positionKeysAlongPath,
  repliesAtPosition,
} from './domain/chessLine'
import {
  TRAINER_STATUS,
  nodeAtPath,
  trainerCurrentChildren,
  trainerExpectedChild,
} from './domain/openingTrainer'
import {
  REVIEW_STATUS,
  reviewCompletedCount,
  reviewDisplayPath,
  reviewPriorPath as getReviewPriorPath,
} from './domain/reviewSession'
import BoardPane from './components/BoardPane'
import EnginePanel from './components/EnginePanel'
import SessionRail from './components/SessionRail'
import AccountSwitcher from './components/AccountSwitcher'
import AccountsModal from './components/AccountsModal'
import ExploreTab from './components/tabs/ExploreTab'
import RepertoireTab from './components/tabs/RepertoireTab'
import PracticeTab from './components/tabs/PracticeTab'
import ReviewTab from './components/tabs/ReviewTab'
import GamesTab from './components/tabs/GamesTab'
import GameReviewPanel from './components/tabs/GameReviewPanel'
import { formatMoveLine, openingFamily, shortMoves } from './utils/formatUtils'

const TIME_CLASSES = [
  { key: '', label: 'All' },
  { key: 'bullet', label: 'Bullet' },
  { key: 'blitz', label: 'Blitz' },
  { key: 'rapid', label: 'Rapid' },
  { key: 'daily', label: 'Daily' },
]

const ACCOUNT_STORAGE_KEY = 'op_account_id'

const TABS = [
  { id: 'Explore', hint: 'Your game stats' },
  { id: 'Repertoire', hint: 'Saved variations' },
  { id: 'Practice', label: 'Train', hint: 'Drill openings with random branching' },
  { id: 'Review', hint: 'Spaced repetition' },
  { id: 'Games', hint: 'Browse and review full games' },
]

export default function OpeningsExplorer() {
  const [activeTab, setActiveTab] = useState('Explore')
  const [color, setColor] = useState('white')
  const [timeClass, setTimeClass] = useState('')
  const {
    path, future, setLine, pushMove, jumpToPath,
    goBack, goForward, goStart, goEnd,
    flipped, setFlipped, flip,
  } = useOpeningNavigation()
  const activeLineKey = path.join(' ')
  const [selectedAccountId, setSelectedAccountId] = useState(() => {
    // Storage can throw (blocked site data, some private modes); that must not
    // take the whole app down at mount — it only costs the remembered account.
    try {
      const stored = Number(localStorage.getItem(ACCOUNT_STORAGE_KEY))
      return stored > 0 ? stored : null
    } catch {
      return null
    }
  })
  const [accountsModalOpen, setAccountsModalOpen] = useState(false)
  const [saveDraft, setSaveDraft] = useState({ opening: '', name: '', tags: [], note: '' })
  const [classifiedOpening, setClassifiedOpening] = useState(null)
  const [tagInput, setTagInput] = useState('')
  const [tagFilter, setTagFilter] = useState(null)
  const [editingBranchId, setEditingBranchId] = useState(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [saveFeedback, setSaveFeedback] = useState('')
  const [reviewGame, setReviewGame] = useState(null)
  const [pendingPromotion, setPendingPromotion] = useState(null)
  const [boardResetKey, setBoardResetKey] = useState(0)
  const [explorerFiltersOpen, setExplorerFiltersOpen] = useState(false)
  const shellRef = useRef(null)
  const boardColumnRef = useRef(null)
  const { repertoire, error: repertoireError, reload: loadRepertoire } = useRepertoire(color)
  const { openings, error: openingsError, reload: loadOpenings } = useOpenings(color)
  // A finished line updates its branch's drill totals, which the Train list's
  // per-opening "trained / clean" counts are built from — refresh both.
  const reloadAfterDrill = useCallback(() => {
    loadOpenings()
    return loadRepertoire()
  }, [loadOpenings, loadRepertoire])
  const {
    trainer, trainerPath, dispatchTrainer, drillWrite,
    stopTrainer, clearTimer: clearTrainerTimer,
  } = useTrainingSession({ activeTab, repertoire, reloadRepertoire: reloadAfterDrill })
  const {
    review, reviewItem, reviewWrite, dispatchReview,
    recordReview, retryReviewWrite, resetReviewWrite,
  } = useReviewSession(loadRepertoire)
  const { tree, loading, error, reload: reloadTree } = useOpeningTree({
    color, pathKey: activeLineKey, timeClass, accountId: selectedAccountId,
    enabled: activeTab === 'Explore' && !trainer && !reviewItem,
  })
  // The games list is fetched the first time the tab is opened, not on every
  // page load; after that it stays loaded (and keeps any "Load more" pages).
  const [gamesTabOpened, setGamesTabOpened] = useState(activeTab === 'Games')
  if (activeTab === 'Games' && !gamesTabOpened) setGamesTabOpened(true)
  const {
    games: gameRows, total: gamesTotal, loading: gamesLoading, error: gamesError,
    hasMore: gamesHasMore, loadMore: loadMoreGames, reload: reloadGames,
  } = useGames({ accountId: selectedAccountId, timeClass, enabled: gamesTabOpened })
  const cancelPromotion = useCallback(() => setPendingPromotion(null), [])
  const resetBoardPosition = useCallback(() => setBoardResetKey((key) => key + 1), [])

  const stopReview = useCallback(() => dispatchReview({ type: 'clear' }), [dispatchReview])

  const closeGame = useCallback(() => {
    setReviewGame(null)
    setLine({ path: [], future: [] })
  }, [setLine])

  // Load a full game onto the review board: seed the line with its mainline so
  // the shared board + analysis rail step through it (no opening-tree fetch).
  const openGame = useCallback(async (game) => {
    clearTrainerTimer()
    dispatchTrainer({ type: 'stop' })
    dispatchReview({ type: 'clear' })
    setActiveTab('Games')
    setFlipped(false)
    try {
      const res = await api.get(`/games/${game.id}`)
      const sans = sansFromPgn(res.data?.pgn)
      setReviewGame({ ...game, ...res.data, sans })
      setLine({ path: [], future: sans })
    } catch {
      setReviewGame({ ...game, sans: [], error: true })
      setLine({ path: [], future: [] })
    }
  }, [clearTrainerTimer, dispatchReview, dispatchTrainer, setFlipped, setLine])

  const exploreBoard = useMemo(() => boardFromPath(path), [path])
  // How many of the open game's moves are currently on the board (leading prefix
  // match) — drives the move-list highlight; a side variation just stops it short.
  const currentGamePly = useMemo(() => {
    if (!reviewGame) return 0
    const sans = reviewGame.sans || []
    let n = 0
    while (n < path.length && n < sans.length && path[n] === sans[n]) n += 1
    return n
  }, [reviewGame, path])
  const trainerBoard = useMemo(() => boardFromPath(trainerPath), [trainerPath])
  const isTraining = Boolean(trainer)
  const isReviewing = Boolean(reviewItem)
  const reviewPriorPath = useMemo(() => getReviewPriorPath(review), [review])
  const reviewBoard = useMemo(() => {
    if (!reviewItem) return { fen: START_FEN, last: null }
    return boardFromPath(reviewDisplayPath(review))
  }, [reviewItem, review])

  const inSession = isTraining || isReviewing
  const boardSize = useBoardSize(shellRef, boardColumnRef)
  const display = isReviewing ? reviewBoard : isTraining ? trainerBoard : exploreBoard
  const displayPath = isReviewing ? reviewPriorPath : isTraining ? trainerPath : path
  const {
    localEval, cloud, target, actionError: evalActionError, fetchCloud,
    deepen, shallow, goInfinite, resetDepth, freeze, saveEval, clearSaved,
  } = usePositionEval(inSession ? null : display.fen)
  const explorerFilters = useExplorerFilters()
  const { explorer, reload: reloadExplorer } = useOpeningExplorer(
    inSession ? null : display.fen, explorerFilters.filters, explorerFilters.filterKey,
  )
  const handleAccountDataChanged = useCallback(() => {
    reloadTree()
    reloadGames()
  }, [reloadTree, reloadGames])
  const accountManager = useAccountManager({
    onDataChanged: handleAccountDataChanged,
    reloadExplorer,
  })
  const { profile, profileError, accounts, hasToken, reloadProfile } = accountManager

  const currentNode = useMemo(() => findNodeByPath(repertoire?.root, path), [repertoire, path])

  useEffect(() => {
    try {
      if (selectedAccountId == null) localStorage.removeItem(ACCOUNT_STORAGE_KEY)
      else localStorage.setItem(ACCOUNT_STORAGE_KEY, String(selectedAccountId))
    } catch {
      // Not persisted this session; the selection itself still works.
    }
  }, [selectedAccountId])

  useEffect(() => { setFlipped(false) }, [color, setFlipped])
  useEffect(() => { setPendingPromotion(null) }, [display.fen])

  useEffect(() => {
    if (!saveFeedback) return undefined
    const t = window.setTimeout(() => setSaveFeedback(''), 3200)
    return () => window.clearTimeout(t)
  }, [saveFeedback])

  // Best-move arrows, one per source, deduped so agreeing sources don't stack:
  //   green = Stockfish best · blue = Lichess cloud-eval best · yellow = Lichess
  //   players' most-played move. Identical in Explore and game review; hidden in
  //   drills (shapes = [] when inSession). Keep colours in sync with the EnginePanel
  //   legend (op-arrow-key) and the chessground brush names.
  const bestMoveUci = localEval?.best_move_uci
  const cloudBestUci = cloud?.source === 'lichess' && cloud.pvs?.[0]?.moves
    ? cloud.pvs[0].moves.split(' ')[0]
    : null
  const explorerBestUci = explorer?.source === 'lichess'
    ? (explorer.moves?.[0]?.uci || null)
    : null
  const exploreShapes = useMemo(() => {
    const sources = [
      { uci: bestMoveUci, brush: 'green' },
      { uci: cloudBestUci, brush: 'blue' },
      { uci: explorerBestUci, brush: 'yellow' },
    ]
    const shapes = []
    const seen = new Set()
    for (const { uci, brush } of sources) {
      if (!uci || uci.length < 4) continue
      const orig = uci.slice(0, 2)
      const dest = uci.slice(2, 4)
      if (seen.has(orig + dest)) continue // one arrow per move — don't stack colours
      seen.add(orig + dest)
      shapes.push({ orig, dest, brush })
    }
    return shapes
  }, [bestMoveUci, cloudBestUci, explorerBestUci])

  const shapes = inSession ? [] : exploreShapes

  const canMoveBoard = isReviewing
    ? activeTab === 'Review' && review.status === REVIEW_STATUS.ASKING
    : isTraining
      ? activeTab === 'Practice'
        && !drillWrite.pending && !drillWrite.error
        && [TRAINER_STATUS.AWAITING_USER_MOVE, TRAINER_STATUS.WRONG_MOVE_FEEDBACK].includes(trainer?.status)
      : true
  const movableDests = useMemo(
    () => (canMoveBoard ? legalDests(display.fen) : null),
    [canMoveBoard, display.fen],
  )

  const movableColor = sideToMove(display.fen)
  const summary = tree?.summary
  const moves = tree?.moves || []
  const branches = useMemo(() => repertoire?.branches || [], [repertoire?.branches])
  const dueNodes = useMemo(() => repertoire?.due || [], [repertoire?.due])
  // Repertoire replies are looked up by the position on the board, not by the
  // move order that reached it, so a transposed line offers the same
  // continuations instead of looking empty.
  const nodesByEpdBefore = useMemo(
    () => indexNodesByEpdBefore(repertoire?.root),
    [repertoire?.root],
  )
  const currentEpd = positionKeyFromFen(display.fen)
  const currentChildren = useMemo(() => {
    const replies = repliesAtPosition(nodesByEpdBefore, currentEpd)
    if (replies.length) return replies
    // Nothing saved at this position: fall back to the literal tree walk, which
    // still covers the empty-root case.
    return currentNode
      ? currentNode.children
      : (path.length ? [] : repertoire?.root?.children || [])
  }, [nodesByEpdBefore, currentEpd, currentNode, path.length, repertoire?.root])
  const openingTitle = reviewGame
    ? (reviewGame.opening || '')
    : (classifiedOpening?.name || tree?.summary?.opening || tree?.moves?.[0]?.opening || '')
  // During a drill or review the board is not the explored line, so naming the
  // explored line's opening up here contradicted the board.
  const headerTitle = isTraining
    ? `Training · ${trainer.scope?.label || 'Openings'}`
    : isReviewing
      ? 'Spaced review'
      : !path.length
        ? 'Starting position'
        : (openingTitle || formatMoveLine(path, 10))
  const headerIsPlaceholder = !inSession && !path.length
  const suggestedName = openingTitle || shortMoves(activeLineKey, 5)

  // Match the exact move order first, then any branch ending on this same
  // position. Matching on the SAN string alone is what let the user save the
  // same line again under a different order, over and over.
  const savedBranchForLine = useMemo(() => {
    const exact = branches.find(branch => branch.moves_san === activeLineKey)
    if (exact || !path.length) return exact || null
    const epd = positionKeyFromFen(exploreBoard.fen)
    return branches.find(branch => branch.terminal_epd && branch.terminal_epd === epd) || null
  }, [branches, activeLineKey, exploreBoard.fen, path.length])
  // True when the position is saved but under a different sequence of moves.
  const savedAsTransposition = Boolean(
    savedBranchForLine && savedBranchForLine.moves_san !== activeLineKey,
  )
  const editingBranch = path.length
    ? (branches.find(branch => branch.id === editingBranchId) || null)
    : null
  const saveTarget = editingBranch || savedBranchForLine
  const lineChanged = Boolean(editingBranch && editingBranch.moves_san !== activeLineKey)
  const conflictBranch = lineChanged && savedBranchForLine && savedBranchForLine.id !== editingBranch.id
    ? savedBranchForLine
    : null
  const selectedAccount = useMemo(
    () => accounts.find(a => a.id === selectedAccountId) || null,
    [accounts, selectedAccountId],
  )
  const allGames = useMemo(() => accounts.reduce((sum, a) => sum + (a.games || 0), 0), [accounts])
  const headerAccountName = selectedAccount ? selectedAccount.username : (accounts.length ? 'All accounts' : null)
  const headerGames = selectedAccount ? selectedAccount.games : allGames

  // If the selected account was removed, fall back to "All accounts".
  useEffect(() => {
    if (selectedAccountId != null && profile && !accounts.some(a => a.id === selectedAccountId)) {
      setSelectedAccountId(null)
    }
  }, [accounts, profile, selectedAccountId])
  const sideToMoveLabel = sideToMove(display.fen) === 'white' ? 'White' : 'Black'
  const trainerStrip = isTraining ? {
    label: trainer.scope?.label || 'Training',
    done: trainer.linesDone,
    total: trainer.linesTotal,
    progress: trainer.linesTotal ? Math.round((trainer.linesDone / trainer.linesTotal) * 100) : 0,
  } : null
  const trainedBranches = branches.filter(branch => branch.drill_count > 0)
  const ungroupedBranches = useMemo(() => branches.filter(b => !b.opening_id), [branches])
  const currentLineTitle = path.length ? formatMoveLine(path, 12) : 'Starting position'
  const duePreview = dueNodes.slice(0, 12)
  const reviewCompleted = reviewCompletedCount(review)

  const allTags = useMemo(() => {
    const seen = new Map()
    for (const b of branches) for (const t of (b.tags || [])) {
      const k = t.toLowerCase()
      if (!seen.has(k)) seen.set(k, t)
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [branches])

  const openingOptions = useMemo(
    () => (openings || []).map(o => o.name).sort((a, b) => a.localeCompare(b)),
    [openings],
  )

  const visibleBranches = useMemo(() => (
    tagFilter
      ? branches.filter(b => (b.tags || []).some(t => t.toLowerCase() === tagFilter.toLowerCase()))
      : branches
  ), [branches, tagFilter])

  const groupedBranches = useMemo(() => {
    const map = new Map()
    for (const b of visibleBranches) {
      const key = (b.opening || '').trim() || 'Ungrouped'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(b)
    }
    return [...map.entries()]
  }, [visibleBranches])

  const inheritedOpening = useMemo(() => {
    // The recognizer names the exact current line most precisely (full variation),
    // so prefer it; fall back to a saved parent's opening, then the family title.
    if (classifiedOpening?.name) return classifiedOpening.name
    // Prefix-matching the SAN text misses a parent saved under another move
    // order, so also accept a branch whose terminal position this line passes
    // through. Deepest match wins either way.
    const passesThrough = new Set(positionKeysAlongPath(activeLineKey))
    let best = null
    for (const b of branches) {
      if (!b.opening) continue
      const matches = activeLineKey === b.moves_san
        || activeLineKey.startsWith(`${b.moves_san} `)
        || (b.terminal_epd && passesThrough.has(b.terminal_epd))
      if (matches && (!best || b.moves_san.length > best.moves_san.length)) best = b
    }
    return best ? best.opening : openingFamily(openingTitle)
  }, [branches, activeLineKey, openingTitle, classifiedOpening])

  // Recognize the opening of the current line so the editor can pre-fill it and
  // the header shows the right name. Cheap, offline lookup keyed by the SAN path.
  useEffect(() => {
    if (!activeLineKey) { setClassifiedOpening(null); return }
    const controller = new AbortController()
    api.get('/openings/classify', { params: { moves_san: activeLineKey }, signal: controller.signal })
      .then(res => { if (!controller.signal.aborted) setClassifiedOpening(res.data || null) })
      .catch(() => { if (!controller.signal.aborted) setClassifiedOpening(null) })
    return () => controller.abort()
  }, [activeLineKey])

  useEffect(() => {
    if (!editingBranchId) return
    if (!branches.some(branch => branch.id === editingBranchId)) {
      setEditingBranchId(null)
      setEditorOpen(false)
    }
  }, [branches, editingBranchId])

  useEffect(() => { setTagFilter(null) }, [color])
  useEffect(() => {
    if (path.length) return
    setEditingBranchId(null)
    setEditorOpen(false)
  }, [path.length])

  useEffect(() => {
    if (saveTarget) {
      setSaveDraft({
        opening: saveTarget.opening || '',
        name: saveTarget.name || '',
        tags: saveTarget.tags || [],
        note: saveTarget.note || '',
      })
    } else {
      setSaveDraft({ opening: inheritedOpening || '', name: '', tags: [], note: '' })
    }
    setTagInput('')
  }, [saveTarget, inheritedOpening])

  const selectColor = useCallback((nextColor) => {
    if (nextColor === color && !path.length && !trainer && !review && !reviewGame) return
    clearTrainerTimer()
    dispatchTrainer({ type: 'stop' })
    dispatchReview({ type: 'clear' })
    setReviewGame(null)
    setEditingBranchId(null)
    setEditorOpen(false)
    setColor(nextColor)
    setLine({ path: [], future: [] })
  }, [clearTrainerTimer, color, dispatchReview, dispatchTrainer, path.length, review, reviewGame, setLine, trainer])

  // Filters narrow the stats for the position you're on; they don't send you
  // back to the start (lichess's explorer behaves the same way).
  const selectTimeClass = useCallback((nextTimeClass) => {
    if (nextTimeClass === timeClass) return
    setTimeClass(nextTimeClass)
    setReviewGame(null)
  }, [timeClass])

  const selectAccount = useCallback((id) => {
    clearTrainerTimer()
    dispatchTrainer({ type: 'stop' })
    dispatchReview({ type: 'clear' })
    setReviewGame(null)
    setSelectedAccountId(id)
  }, [clearTrainerTimer, dispatchReview, dispatchTrainer])

  const addAccount = useCallback(async (platform, username) => {
    const res = await accountManager.add(platform, username)
    const newId = res?.data?.account?.id
    if (newId) setSelectedAccountId(newId)
    return res
  }, [accountManager])

  const syncAccount = accountManager.sync
  const cancelAccountSync = accountManager.cancelSync

  const deleteAccount = useCallback(async (id) => {
    await accountManager.remove(id)
    setSelectedAccountId(prev => (prev === id ? null : prev))
  }, [accountManager])

  const saveLichessToken = accountManager.saveToken

  const playMove = (san) => {
    const result = applySanMove(exploreBoard.fen, san)
    if (!result) return
    playStepSound(result.san)
    pushMove(result.san)
  }

  const playAnalysisLine = useCallback((sans) => {
    const accepted = []
    let fen = exploreBoard.fen
    for (const san of sans || []) {
      const result = applySanMove(fen, san)
      if (!result) break
      accepted.push(result.san)
      fen = result.fenAfter
    }
    if (!accepted.length) {
      playIllegalSound()
      return
    }
    playStepSound(accepted[0])
    jumpToPath([...path, ...accepted])
  }, [exploreBoard.fen, jumpToPath, path])

  const completeMove = useCallback((fen, orig, dest, promotion, onAccepted) => {
    const result = makeMove(fen, orig, dest, promotion)
    if (!result) {
      playIllegalSound()
      resetBoardPosition()
      return
    }
    onAccepted(result)
  }, [resetBoardPosition])

  const queuePromotion = useCallback((fen, orig, dest, onAccepted) => {
    const piece = pieceAt(fen, orig)
    if (!piece) return
    setPendingPromotion({ from: orig, to: dest, color: piece.color, fen, onAccepted })
  }, [])

  const handleExploreBoardMove = useCallback((orig, dest) => {
    if (pendingPromotion) return
    const fen = exploreBoard.fen
    if (needsPromotion(fen, orig, dest)) {
      queuePromotion(fen, orig, dest, (move) => {
        playStepSound(move.san)
        pushMove(move.san)
      })
      return
    }
    completeMove(fen, orig, dest, 'q', (move) => {
      playStepSound(move.san)
      pushMove(move.san)
    })
  }, [exploreBoard.fen, pendingPromotion, queuePromotion, completeMove, pushMove])

  const handlePromotionSelect = useCallback((piece) => {
    if (!pendingPromotion) return
    const { from, to, fen, onAccepted } = pendingPromotion
    setPendingPromotion(null)
    completeMove(fen, from, to, piece, onAccepted)
  }, [pendingPromotion, completeMove])

  const addTag = useCallback((raw) => {
    const tag = (raw || '').trim().replace(/,$/, '').trim()
    if (!tag) return
    setSaveDraft(d => (
      d.tags.some(t => t.toLowerCase() === tag.toLowerCase())
        ? d
        : { ...d, tags: [...d.tags, tag] }
    ))
    setTagInput('')
  }, [])

  const removeTag = useCallback((tag) => {
    setSaveDraft(d => ({ ...d, tags: d.tags.filter(t => t !== tag) }))
  }, [])

  const handleTagKeyDown = useCallback((e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(e.currentTarget.value)
    } else if (e.key === 'Backspace' && !e.currentTarget.value) {
      setSaveDraft(d => (d.tags.length ? { ...d, tags: d.tags.slice(0, -1) } : d))
    }
  }, [addTag])

  const draftPayload = () => {
    const pendingTag = tagInput.trim()
    const tags = pendingTag && !saveDraft.tags.some(t => t.toLowerCase() === pendingTag.toLowerCase())
      ? [...saveDraft.tags, pendingTag]
      : saveDraft.tags
    const name = saveDraft.name.trim() || saveTarget?.name || suggestedName || path.join(' ')
    return {
      color,
      name,
      moves_san: activeLineKey,
      opening: saveDraft.opening.trim(),
      tags,
      note: saveDraft.note.trim(),
    }
  }

  const persistBranch = async (target) => {
    if (!path.length) return
    const payload = draftPayload()
    try {
      const res = target
        ? await api.patch(`/repertoire/tree/branches/${target.id}`, payload)
        : await api.post('/repertoire/tree/branches', payload)
      setEditingBranchId(res.data.id)
      setEditorOpen(false)
      setTagInput('')
      setSaveFeedback(res.data.training_reset
        ? `Updated “${res.data.name || payload.name}” · training totals reset for the changed line`
        : `${target ? 'Updated' : 'Saved'} “${res.data.name || payload.name}”`)
      setActiveTab('Repertoire')
      await loadRepertoire()
      loadOpenings()
    } catch (err) {
      const detail = err?.response?.data?.detail
      setSaveFeedback(detail || 'Could not save this variation')
    }
  }

  const saveCurrentBranch = () => persistBranch(saveTarget)
  const saveAsNewBranch = () => persistBranch(null)

  const stopEditing = useCallback(() => {
    setEditingBranchId(null)
    setEditorOpen(false)
  }, [])

  const resetToSavedLine = useCallback(() => {
    if (editingBranch) jumpToPath(splitSanLine(editingBranch.moves_san))
  }, [editingBranch, jumpToPath])

  const deleteBranch = async (branch) => {
    try {
      await api.delete(`/repertoire/tree/branches/${branch.id}`)
      // Deleting from inside the editor must close it: left open, it fell back
      // to a "New variation" form still showing the delete confirmation.
      if (editingBranchId === branch.id) setEditingBranchId(null)
      setEditorOpen(false)
      setSaveFeedback(`Deleted “${branch.name}”`)
      await loadRepertoire()
      loadOpenings()
    } catch {
      setSaveFeedback('Could not delete this variation')
    }
  }

  const createOpening = useCallback(async (name) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return
    try {
      await api.post('/repertoire/openings', { color, name: trimmed })
      setSaveFeedback(`Created opening “${trimmed}”`)
      loadOpenings()
    } catch (err) {
      setSaveFeedback(err?.response?.data?.detail || 'Could not create opening')
    }
  }, [color, loadOpenings])

  const renameOpening = useCallback(async (opening, name) => {
    const trimmed = (name || '').trim()
    if (!trimmed || trimmed === opening.name) return
    try {
      await api.patch(`/repertoire/openings/${opening.id}`, { name: trimmed })
      setSaveFeedback(`Renamed to “${trimmed}”`)
      await loadOpenings()
      loadRepertoire()
    } catch (err) {
      setSaveFeedback(err?.response?.data?.detail || 'Could not rename opening')
    }
  }, [loadOpenings, loadRepertoire])

  const deleteOpening = useCallback(async (opening) => {
    try {
      await api.delete(`/repertoire/openings/${opening.id}`)
      setSaveFeedback(`Deleted opening “${opening.name}”`)
      await loadOpenings()
      loadRepertoire()
    } catch {
      setSaveFeedback('Could not delete opening')
    }
  }, [loadOpenings, loadRepertoire])

  const loadBranch = (branch) => {
    clearTrainerTimer()
    dispatchTrainer({ type: 'stop' })
    dispatchReview({ type: 'clear' })
    setColor(branch.color)
    jumpToPath(splitSanLine(branch.moves_san))
    setEditingBranchId(branch.id)
    setEditorOpen(true)
    setActiveTab('Repertoire')
  }

  const startTraining = useCallback(({ branches: scopeBranches, userColor, scope }) => {
    clearTrainerTimer()
    dispatchReview({ type: 'clear' })
    setEditingBranchId(null)
    setEditorOpen(false)
    drillWrite.clear()
    setActiveTab('Practice')
    dispatchTrainer({ type: 'start', payload: { branches: scopeBranches, userColor, scope } })
  }, [clearTrainerTimer, dispatchReview, dispatchTrainer, drillWrite])

  // Drill a single saved line (a one-leaf scope).
  const startPractice = useCallback((branch) => {
    setColor(branch.color)
    startTraining({ branches: [branch], userColor: branch.color, scope: { type: 'branch', label: branch.name } })
  }, [startTraining])

  const startOpeningTraining = useCallback((opening) => {
    startTraining({
      branches: branches.filter(b => b.opening_id === opening.id),
      userColor: color,
      scope: { type: 'opening', id: opening.id, label: opening.name },
    })
  }, [branches, color, startTraining])

  const startUngroupedTraining = useCallback(() => {
    startTraining({
      branches: ungroupedBranches,
      userColor: color,
      scope: { type: 'ungrouped', label: 'Ungrouped lines' },
    })
  }, [ungroupedBranches, color, startTraining])

  const startAllTraining = useCallback(() => {
    startTraining({ branches, userColor: color, scope: { type: 'all', label: 'All openings' } })
  }, [branches, color, startTraining])

  const continueTraining = useCallback(() => dispatchTrainer({ type: 'continue' }), [dispatchTrainer])

  const handleTrainMove = useCallback((orig, dest) => {
    if (
      !trainer ||
      ![TRAINER_STATUS.AWAITING_USER_MOVE, TRAINER_STATUS.WRONG_MOVE_FEEDBACK].includes(trainer.status) ||
      pendingPromotion
    ) return
    const fen = display.fen

    const finishMove = (result) => {
      // Any saved reply at this position is acceptable; resolve each child to its
      // stored node (for fen fallback + drill recording).
      const resolved = trainerCurrentChildren(trainer).map(child => ({
        child,
        node: findNodeByPath(repertoire?.root, child.path),
      }))
      const hit = resolved.find(({ child, node }) =>
        isExpectedMove(result, {
          san: child.san, fen_after: node?.fen_after, epd_after: node?.epd_after,
        }))

      if (!hit) {
        // Before calling it a miss: the drill tree walks saved *move orders*, so
        // a move that is genuinely in the drilled lines at this position — just
        // reached another way — would otherwise be marked wrong. Knowing the
        // transposition should not cost you the card.
        //
        // Only replies inside the drill's own scope count. The position index
        // spans the whole repertoire, so without this check 1.e4 passed as a
        // "clean line" in a 1.d4-only drill because some *other* opening plays it.
        const transposed = repliesAtPosition(nodesByEpdBefore, positionKeyFromFen(fen))
          .filter(reply => nodeAtPath(trainer.tree, splitSanLine(reply.path_san)))
        const match = matchExpectedMove(result, transposed)
        if (match) {
          playStepSound(result.san)
          // Carry on down the drill tree from the other move order's node, which
          // is the same position with the same continuations.
          dispatchTrainer({ type: 'userMove', childPath: splitSanLine(match.path_san), san: result.san })
          return
        }
        playIllegalSound()
        resetBoardPosition()
        const expected = resolved[0]
        if (expected?.node?.id) {
          drillWrite.send({
            solved: false,
            source: 'practice',
            node_id: expected.node.id,
            expected_san: expected.child.san,
            played_san: result.san,
            path_san: expected.child.path.join(' '),
          }, resetBoardPosition)
        }
        dispatchTrainer({ type: 'userWrong', playedSan: result.san, expectedSan: expected?.child.san })
        return
      }
      playStepSound(result.san)
      const missedHere = trainer.lineMisses.some(m => m.path === trainerPath.join(' '))
      if (hit.node?.id && !missedHere) {
        drillWrite.send({
          solved: true,
          source: 'practice',
          node_id: hit.node.id,
          expected_san: hit.child.san,
          played_san: result.san,
          path_san: hit.child.path.join(' '),
        })
      }
      dispatchTrainer({ type: 'userMove', childPath: hit.child.path, san: result.san })
    }

    if (needsPromotion(fen, orig, dest)) {
      queuePromotion(fen, orig, dest, finishMove)
      return
    }
    const result = makeMove(fen, orig, dest, 'q')
    if (!result) {
      playIllegalSound()
      resetBoardPosition()
      return
    }
    finishMove(result)
  }, [trainer, trainerPath, display.fen, pendingPromotion, repertoire, drillWrite, queuePromotion, resetBoardPosition, dispatchTrainer, nodesByEpdBefore])

  const startReview = useCallback(() => {
    if (!dueNodes.length) return
    clearTrainerTimer()
    dispatchTrainer({ type: 'stop' })
    setEditingBranchId(null)
    setEditorOpen(false)
    setActiveTab('Review')
    resetReviewWrite()
    dispatchReview({ type: 'start', dueNodes })
  }, [clearTrainerTimer, dispatchReview, dispatchTrainer, dueNodes, resetReviewWrite])

  const nextReview = useCallback(() => dispatchReview({ type: 'next' }), [dispatchReview])
  const completeReview = useCallback(() => dispatchReview({ type: 'finish' }), [dispatchReview])
  const finishReview = useCallback(() => {
    dispatchReview({ type: 'clear' })
    resetReviewWrite()
  }, [dispatchReview, resetReviewWrite])

  const handleReviewMove = useCallback((orig, dest) => {
    if (!review || review.status !== REVIEW_STATUS.ASKING || !reviewItem || pendingPromotion) return
    const fen = reviewBoard.fen

    const grade = (result) => {
      // Any reply saved at this position counts: the card is one question with
      // possibly several right answers, including transposed ones.
      const matched = matchExpectedMove(result, reviewItem.accepted)
      if (matched) {
        playStepSound(result.san)
        recordReview(reviewItem, true, result.san, undefined, matched)
        dispatchReview({ type: 'userMoveResult', correct: true, playedSan: result.san })
      } else {
        playIllegalSound()
        recordReview(reviewItem, false, result.san)
        dispatchReview({ type: 'userMoveResult', correct: false, playedSan: result.san })
      }
    }

    if (needsPromotion(fen, orig, dest)) {
      queuePromotion(fen, orig, dest, grade)
      return
    }
    const result = makeMove(fen, orig, dest, 'q')
    if (!result) {
      playIllegalSound()
      resetBoardPosition()
      return
    }
    grade(result)
  }, [review, reviewItem, reviewBoard.fen, pendingPromotion, queuePromotion, recordReview, resetBoardPosition, dispatchReview])

  const boardOnMove = isReviewing && activeTab === 'Review'
    ? handleReviewMove
    : isTraining && activeTab === 'Practice'
      ? handleTrainMove
      : handleExploreBoardMove

  const baseOrientation = isReviewing
    ? reviewItem.color
    : isTraining
      ? trainer.userColor
      : (reviewGame ? (reviewGame.user_color || 'white') : color)
  const orientation = flipped
    ? (baseOrientation === 'white' ? 'black' : 'white')
    : baseOrientation

  useOpeningsKeyboard({
    paused: accountsModalOpen,
    enabled: !inSession,
    engineEnabled: !inSession,
    pendingPromotion,
    cancelPromotion,
    goBack,
    goForward,
    goStart,
    goEnd,
    flip,
    deepen,
    shallow,
    freeze,
  })

  const exitSession = useCallback(() => {
    stopTrainer()
    stopReview()
    goStart()
  }, [stopTrainer, stopReview, goStart])

  const handleCrumbClick = useCallback((i) => {
    setLine(({ path, future }) => ({
      path: path.slice(0, i + 1),
      future: [...path.slice(i + 1), ...future],
    }))
  }, [setLine])

  return (
    <div className="cr2 openings-workspace">
      <header className="op-toolbar">
        <div className="op-toolbar-intro">
          <h1 className={`op-opening-title${headerIsPlaceholder ? ' placeholder' : ''}`} title={headerTitle}>
            {headerTitle}
          </h1>
          <p className="op-meta">
            {headerAccountName ? <span className="op-user">{headerAccountName}</span> : null}
            {profile === null && !profileError
              ? 'Loading account data…'
              : accounts.length
              ? `${headerAccountName ? ' · ' : ''}${headerGames.toLocaleString()} games`
              : 'Add an account to explore your games'}
          </p>
        </div>
        <div className="op-toolbar-controls">
          <AccountSwitcher
            accounts={accounts}
            loading={profile === null && !profileError}
            selectedAccountId={selectedAccountId}
            allGames={allGames}
            onSelect={selectAccount}
            onManage={() => setAccountsModalOpen(true)}
          />
          {profileError && <button type="button" className="chip danger" onClick={reloadProfile}>{profileError} · Retry</button>}
          <div className="seg" role="tablist" aria-label="Color">
            <button type="button" className={color === 'white' ? 'on' : ''} onClick={() => selectColor('white')} aria-pressed={color === 'white'}>White</button>
            <button type="button" className={color === 'black' ? 'on' : ''} onClick={() => selectColor('black')} aria-pressed={color === 'black'}>Black</button>
          </div>
          <div className="op-times" role="group" aria-label="Time control">
            {TIME_CLASSES.map(t => (
              <button key={t.key} type="button" className={`chip ${timeClass === t.key ? 'on' : ''}`} onClick={() => selectTimeClass(t.key)} aria-pressed={timeClass === t.key}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="op-shell" ref={shellRef}>
        <aside
          className="op-analysis-rail"
          aria-label={inSession ? 'Session progress' : 'Engine analysis'}
        >
          {inSession ? (
            <SessionRail
              isTraining={isTraining}
              trainerStrip={trainerStrip}
              isReviewing={isReviewing}
              review={review}
              reviewItem={reviewItem}
              reviewCompleted={reviewCompleted}
            />
          ) : (
            <EnginePanel
              fen={display.fen}
              stockfish={profile?.stockfish}
              localEval={localEval}
              cloud={cloud}
              explorer={explorer}
              sideToMove={sideToMoveLabel}
              target={target}
              actionError={evalActionError}
              explorerFilters={explorerFilters}
              filtersOpen={explorerFiltersOpen}
              onToggleFilters={() => setExplorerFiltersOpen(open => !open)}
              onLineSelect={playAnalysisLine}
              onConfigureToken={() => setAccountsModalOpen(true)}
              onFetchCloud={fetchCloud}
              onDeepen={deepen}
              onShallow={shallow}
              onGoInfinite={goInfinite}
              onResetDepth={resetDepth}
              onFreeze={freeze}
              onSaveEval={saveEval}
              onClearSaved={clearSaved}
            />
          )}
        </aside>

        <BoardPane
          boardSize={boardSize}
          columnRef={boardColumnRef}
          inSession={inSession}
          display={display}
          displayPath={displayPath}
          path={path}
          orientation={orientation}
          shapes={shapes}
          movableDests={movableDests}
          movableColor={movableColor}
          boardOnMove={boardOnMove}
          pendingPromotion={pendingPromotion}
          onPromotionSelect={handlePromotionSelect}
          onPromotionCancel={() => setPendingPromotion(null)}
          boardResetKey={boardResetKey}
          onExitSession={exitSession}
          onGoStart={goStart}
          onGoBack={goBack}
          canGoForward={future.length > 0}
          onGoForward={goForward}
          onFlip={flip}
          onCrumbClick={handleCrumbClick}
        />

        <section className="op-panel" aria-label="Workspace">
          <div className="workspace-tabs" role="tablist" aria-label="Opening workspace">
            {TABS.map(tab => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? 'on' : ''}
                onClick={() => setActiveTab(tab.id)}
                title={tab.hint}
              >
                {tab.label || tab.id}
                {tab.id === 'Review' && repertoire?.stats?.due ? (
                  <span className="tab-badge">{repertoire.stats.due}</span>
                ) : null}
                {tab.id === 'Games' && reviewGame ? (
                  <span className="tab-badge" title="Game in review">●</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="op-panel-body">
            {(repertoireError || openingsError) && (
              <div className="review-write-error" role="alert">
                <span>Could not refresh repertoire data. Last loaded data is still shown.</span>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => { loadRepertoire(); loadOpenings() }}
                >
                  Retry
                </button>
              </div>
            )}
            {activeTab === 'Explore' && inSession && (
              // The tree is not fetched mid-session (it would spoil the answer),
              // so showing ExploreTab here meant stats for some earlier position.
              <div className="tab-pane" role="tabpanel">
                <div className="op-empty">
                  <strong>{isTraining ? 'Drill in progress' : 'Review in progress'}</strong>
                  <p>Your game stats would give away the answer, so Explore waits until you finish.</p>
                  <div className="op-empty-actions">
                    <button type="button" className="btn-primary" onClick={() => setActiveTab(isTraining ? 'Practice' : 'Review')}>
                      {isTraining ? 'Back to drill' : 'Back to review'}
                    </button>
                    <button type="button" className="btn-secondary" onClick={exitSession}>
                      {isTraining ? 'Exit drill' : 'End review'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'Explore' && !inSession && (
              <ExploreTab
                sideToMove={sideToMoveLabel}
                path={path}
                currentLineTitle={currentLineTitle}
                saveTarget={saveTarget}
                summary={summary}
                loading={loading}
                error={error}
                moves={moves}
                directGames={tree?.direct_games || 0}
                transpositions={tree?.transpositions || []}
                onSave={saveCurrentBranch}
                onPlayMove={playMove}
                onJumpToPath={jumpToPath}
                onReload={reloadTree}
              />
            )}

            {activeTab === 'Repertoire' && (
              <RepertoireTab
                color={color}
                path={path}
                editorOpen={editorOpen}
                saveTarget={saveTarget}
                editingBranch={editingBranch}
                currentLineTitle={currentLineTitle}
                lineChanged={lineChanged}
                conflictBranch={conflictBranch}
                saveDraft={saveDraft}
                tagInput={tagInput}
                suggestedName={suggestedName}
                saveFeedback={saveFeedback}
                branches={branches}
                groupedBranches={groupedBranches}
                allTags={allTags}
                tagFilter={tagFilter}
                dueNodes={dueNodes}
                dueCount={repertoire?.stats?.due || 0}
                transpositions={repertoire?.transpositions || []}
                repertoire={repertoire}
                openings={openings}
                activeLineKey={activeLineKey}
                currentChildren={currentChildren}
                onPlayMove={playMove}
                savedAsTransposition={savedAsTransposition}
                openingOptions={openingOptions}
                onCreateOpening={createOpening}
                onRenameOpening={renameOpening}
                onDeleteOpening={deleteOpening}
                onSaveDraftChange={(patch) => setSaveDraft(d => ({ ...d, ...patch }))}
                onTagInputChange={setTagInput}
                onTagKeyDown={handleTagKeyDown}
                onAddTag={addTag}
                onRemoveTag={removeTag}
                onSave={saveCurrentBranch}
                onSaveAsNew={saveAsNewBranch}
                onStartPractice={startPractice}
                onDeleteBranch={deleteBranch}
                onStopEditing={stopEditing}
                onLoadBranch={loadBranch}
                onLoadConflict={loadBranch}
                onResetToSaved={resetToSavedLine}
                onStartReview={startReview}
                onSetEditorOpen={setEditorOpen}
                onSetTagFilter={setTagFilter}
                onJumpToPath={jumpToPath}
              />
            )}

            {activeTab === 'Practice' && (
              <PracticeTab
                trainer={trainer}
                color={color}
                openings={openings}
                branches={branches}
                ungroupedBranches={ungroupedBranches}
                expectedHintSan={trainer?.hint ? trainerExpectedChild(trainer)?.san : null}
                drillWrite={drillWrite}
                onRetryWrite={drillWrite.retry}
                onStartOpening={startOpeningTraining}
                onStartUngrouped={startUngroupedTraining}
                onStartAll={startAllTraining}
                onStartBranch={startPractice}
                onContinue={continueTraining}
                onExit={stopTrainer}
                onLoadBranch={loadBranch}
                onOpenRepertoire={() => setActiveTab('Repertoire')}
              />
            )}

            {activeTab === 'Review' && (
              <ReviewTab
                review={review}
                reviewItem={reviewItem}
                reviewPriorPath={reviewPriorPath}
                dueNodes={dueNodes}
                dueCount={repertoire?.stats?.due || 0}
                duePreview={duePreview}
                branches={branches}
                trainedBranches={trainedBranches}
                onStartReview={startReview}
                onFinishReview={finishReview}
                onNextReview={nextReview}
                onCompleteReview={completeReview}
                reviewWrite={reviewWrite}
                onRetryReviewWrite={retryReviewWrite}
                onOpenPractice={() => setActiveTab('Practice')}
                onJumpToPath={jumpToPath}
                onClearReview={() => dispatchReview({ type: 'clear' })}
                onSetActiveTab={setActiveTab}
              />
            )}

            {activeTab === 'Games' && (
              reviewGame ? (
                <GameReviewPanel
                  game={reviewGame}
                  sans={reviewGame.sans || []}
                  currentPly={currentGamePly}
                  onSelectPly={(ply) => setLine({
                    path: (reviewGame.sans || []).slice(0, ply),
                    future: (reviewGame.sans || []).slice(ply),
                  })}
                  onClose={closeGame}
                />
              ) : (
                <GamesTab
                  games={gameRows}
                  total={gamesTotal}
                  loading={gamesLoading}
                  error={gamesError}
                  hasMore={gamesHasMore}
                  accountName={headerAccountName}
                  onOpenGame={openGame}
                  onLoadMore={loadMoreGames}
                  onReload={reloadGames}
                />
              )
            )}
          </div>
        </section>
      </div>

      {accountsModalOpen && (
        <AccountsModal
          accounts={accounts}
          hasToken={hasToken}
          onAdd={addAccount}
          onSync={syncAccount}
          onCancelSync={cancelAccountSync}
          onDelete={deleteAccount}
          onSaveToken={saveLichessToken}
          onClose={() => setAccountsModalOpen(false)}
        />
      )}
    </div>
  )
}
