/** Header control: pick which tracked account's games drive the opening tree
 *  ("All accounts" combines them), plus a button to open the accounts manager. */
export default function AccountSwitcher({ accounts, selectedAccountId, allGames, loading = false, onSelect, onManage }) {
  if (loading) {
    return <div className="op-accounts"><span className="op-account-loading" role="status">Loading accounts…</span></div>
  }
  return (
    <div className="op-accounts" role="group" aria-label="Account">
      {accounts.length > 0 && (
        <select
          className="op-account-select"
          value={selectedAccountId ?? 'all'}
          onChange={(e) => onSelect(e.target.value === 'all' ? null : Number(e.target.value))}
          aria-label="Account"
        >
          <option value="all">All accounts ({allGames.toLocaleString()})</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.username} ({a.games.toLocaleString()})
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="chip op-accounts-manage"
        onClick={onManage}
        title="Add accounts & Lichess token"
      >
        {accounts.length > 0 ? 'Accounts' : '+ Add account'}
      </button>
    </div>
  )
}
