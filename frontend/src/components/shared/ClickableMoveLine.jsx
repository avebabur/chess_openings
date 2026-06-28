import { Fragment } from 'react'

export default function ClickableMoveLine({ moves, onSelect, className = '' }) {
  if (!moves?.length) return null
  return (
    <span className={`op-pv-line ${className}`.trim()}>
      {moves.map((san, i) => (
        <Fragment key={`${i}-${san}`}>
          {i > 0 && ' '}
          <button
            type="button"
            className="op-pv-move"
            onClick={(e) => {
              e.stopPropagation()
              onSelect(moves.slice(0, i + 1))
            }}
            title={`Go to: ${moves.slice(0, i + 1).join(' ')}`}
          >
            {san}
          </button>
        </Fragment>
      ))}
    </span>
  )
}
