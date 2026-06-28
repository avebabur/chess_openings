import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'

const PIECES = [
  { piece: 'q', label: 'Queen' },
  { piece: 'r', label: 'Rook' },
  { piece: 'b', label: 'Bishop' },
  { piece: 'n', label: 'Knight' },
]

const PIECE_CHARS = {
  q: { w: '♕', b: '♛' },
  r: { w: '♖', b: '♜' },
  b: { w: '♗', b: '♝' },
  n: { w: '♘', b: '♞' },
}

export default function PromotionDialog({ color, onSelect, onCancel }) {
  const dialogRef = useDialogFocusTrap(onCancel)
  return (
    <div className="promotion-overlay" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="promotion-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Choose promotion piece"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <p className="promotion-title">Promote to</p>
        <div className="promotion-choices">
          {PIECES.map(({ piece, label }) => (
            <button
              key={piece}
              type="button"
              className="promotion-piece"
              onClick={() => onSelect(piece)}
              title={label}
              aria-label={`Promote to ${label}`}
            >
              {PIECE_CHARS[piece][color]}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
