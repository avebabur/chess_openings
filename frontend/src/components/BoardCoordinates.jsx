import { memo } from 'react'

/** Rank numbers on the left edge of the board (above pieces). */
export default memo(function BoardCoordinates({ boardSize, orientation = 'white' }) {
  const sq = boardSize / 8
  const fontSize = Math.max(11, Math.round(boardSize / 44))
  const ranks = orientation === 'white'
    ? [8, 7, 6, 5, 4, 3, 2, 1]
    : [1, 2, 3, 4, 5, 6, 7, 8]

  return (
    <div className="board-coordinates-ranks" aria-hidden>
      {ranks.map((rank, i) => (
        <span
          key={`r${rank}`}
          className="board-coord board-coord-rank"
          style={{
            top: i * sq + sq - fontSize - 4,
            left: 4,
            fontSize,
            lineHeight: `${fontSize}px`,
          }}
        >
          {rank}
        </span>
      ))}
    </div>
  )
})

/** File letters below the board frame. */
export function BoardFileStrip({ boardSize, orientation = 'white' }) {
  const fontSize = Math.max(11, Math.round(boardSize / 44))
  const files = orientation === 'white'
    ? ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    : ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']

  return (
    <div
      className="board-files-strip"
      style={{ width: boardSize, fontSize, lineHeight: `${fontSize}px` }}
      aria-hidden
    >
      {files.map((file) => (
        <span key={file} className="board-coord board-coord-file">
          {file}
        </span>
      ))}
    </div>
  )
}
