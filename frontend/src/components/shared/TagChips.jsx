export default function TagChips({ tags, onRemove, className = '' }) {
  if (!tags?.length) return null
  return (
    <span className={`tag-chips ${className}`.trim()}>
      {tags.map((tag) => (
        <span key={tag} className="tag-chip">
          {tag}
          {onRemove && (
            <button
              type="button"
              className="tag-chip-x"
              onClick={(e) => { e.stopPropagation(); onRemove(tag) }}
              aria-label={`Remove tag ${tag}`}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </span>
  )
}
