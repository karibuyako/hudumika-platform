import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  adminListConversations,
  blockConversation,
  type ConversationDetail,
  type ConversationStatus,
} from '@hudumika/contract'
import { toLocal } from '../../lib/time'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { DetailDrawer } from '../../components/DetailDrawer'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

const STATUSES: ConversationStatus[] = ['open', 'archived', 'blocked']

type StatusFilter = 'all' | ConversationStatus

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...STATUSES.map((s) => ({ key: s as StatusFilter, label: s })),
]

const STATUS_TONE: Record<ConversationStatus, 'info' | 'muted' | 'bad'> = {
  open: 'info',
  archived: 'muted',
  blocked: 'bad',
}

const COLUMNS: DataTableColumn<ConversationDetail>[] = [
  { key: 'id', header: 'ID', render: (c) => c.id, className: 'mono' },
  { key: 'status', header: 'Status', render: (c) => <StatusPill status={c.status} tone={STATUS_TONE[c.status]} /> },
  { key: 'participant', header: 'Participant', render: (c) => participantLabel(c) },
  { key: 'createdAt', header: 'Created', render: (c) => toLocal(c.createdAt), sortValue: (c) => c.createdAt ?? null, className: 'muted' },
  { key: 'updatedAt', header: 'Updated', render: (c) => toLocal(c.updatedAt), className: 'muted' },
]

export function ConversationsPage() {
  const [conversations, setConversations] = useState<ConversationDetail[] | null>(null)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<ConversationDetail | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    const params = status === 'all' ? undefined : { status }
    adminListConversations(params).then((res) => {
      if (res.status === 200) setConversations(res.data)
      else setError(parseApiError(res, 'Failed to load conversations'))
    })
  }, [status])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    const map: Partial<Record<StatusFilter, number>> = { all: conversations?.length ?? 0 }
    for (const s of STATUSES) map[s] = (conversations ?? []).filter((c) => c.status === s).length
    return map
  }, [conversations])

  if (error) {
    return (
      <ErrorState
        title="Failed to load conversations"
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!conversations) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Conversations</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>
      <FilterChips
        options={FILTERS}
        value={status}
        onChange={setStatus}
        counts={counts}
        ariaLabel="Conversation status filters"
      />

      <DataTable
        rows={conversations}
        columns={COLUMNS}
        rowKey={(c) => c.id}
        onRowClick={setSelected}
        exportable
        exportFileName="conversations"
        tableId="conversations"
        emptyTitle="No conversations found"
        emptyHint="Customer chat appears here once conversations begin."
        ariaLabel="Conversations"
      />

      {selected && <ConversationDrawer conversation={selected} onClose={() => setSelected(null)} onBlocked={() => { setToast(`${selected.id} blocked`); setSelected(null); setRetryKey((k) => k + 1) }} />}
    </div>
  )
}

function participantLabel(c: ConversationDetail): string {
  const p = c.participants[0]
  if (!p) return '—'
  return p.maskedPhone ? `${p.displayName} · ${p.maskedPhone}` : p.displayName
}

function ConversationDrawer({
  conversation,
  onClose,
  onBlocked,
}: {
  conversation: ConversationDetail
  onClose: () => void
  onBlocked: () => void
}) {
  const session = useSession()
  const canBlock = can(session, 'conversation.block')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [blockError, setBlockError] = useState<ApiErrorInfo | null>(null)

  async function runBlock(reason: string) {
    setBusy(true)
    setBlockError(null)
    const res = await blockConversation(conversation.id, { reason })
    if (res.status === 200) {
      setConfirming(false)
      onBlocked()
    } else {
      setBlockError(parseApiError(res, 'Failed to block conversation'))
    }
    setBusy(false)
  }

  return (
    <DetailDrawer title={conversation.id} onClose={onClose}>
      <div className="detail-section">
        <h3>Conversation</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="meta-value mono">{conversation.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              <StatusPill status={conversation.status} tone={STATUS_TONE[conversation.status]} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Created</span>
            <span className="meta-value">{toLocal(conversation.createdAt)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Updated</span>
            <span className="meta-value">{toLocal(conversation.updatedAt)}</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Participants</h3>
        {conversation.participants.length === 0 ? (
          <p className="muted small">No participants</p>
        ) : (
          <div className="meta-grid">
            {conversation.participants.map((p, i) => (
              <div key={i} className="meta-item">
                <span className="meta-label">Participant</span>
                <span className="meta-value">
                  <span className="tag">{p.role}</span> {p.displayName}{' '}
                  <span className="masked">{p.maskedPhone ?? '—'}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {canBlock && conversation.status !== 'blocked' && (
        <div className="detail-section">
          <h3>Moderation</h3>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setBlockError(null)
                setConfirming(true)
              }}
            >
              Block
            </button>
          </div>
        </div>
      )}

      <p className="muted small">
        Blocking notifies both parties (conversation.blocked) and is audited (conversation.*). Staff
        never reply — read-only oversight. Phones are masked by default.
      </p>

      {confirming && (
        <ReasonPrompt
          title="Block conversation"
          description="Blocks this conversation — both parties are notified (conversation.blocked)."
          tone="danger"
          busy={busy}
          error={blockError}
          onSubmit={(reason) => void runBlock(reason)}
          onClose={() => setConfirming(false)}
        />
      )}
    </DetailDrawer>
  )
}
