import { useState, useEffect } from 'react'
import { fetchComments, addComment } from '../api/client'
import { formatDistanceToNow } from 'date-fns'

export function CommentsSection({ wiId }) {
  const [comments, setComments] = useState([])
  const [body, setBody] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    try {
      setComments(await fetchComments(wiId))
    } catch {}
  }

  useEffect(() => { load() }, [wiId])

  const post = async () => {
    if (!body.trim()) return
    setPosting(true); setError('')
    try {
      await addComment(wiId, body)
      setBody('')
      await load()
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed to post')
    } finally { setPosting(false) }
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)', letterSpacing: '0.1em', marginBottom: 12 }}>
        COMMENTS ({comments.length})
      </div>

      {comments.map(c => (
        <div key={c.id} style={{
          marginBottom: 10, padding: '10px 12px',
          background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 4,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)' }}>
              @{c.author_username || c.author_id.slice(0, 8)}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)' }}>
              {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
            </span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-0)' }}>{c.body}</div>
        </div>
      ))}

      {comments.length === 0 && (
        <div style={{ color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 12, marginBottom: 12 }}>
          no comments yet
        </div>
      )}

      <textarea
        placeholder="Add a comment..."
        value={body}
        onChange={e => setBody(e.target.value)}
        style={{ marginTop: 8 }}
        onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) post() }}
      />
      {error && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--p0)', marginTop: 4 }}>{error}</div>}
      <button onClick={post} disabled={posting || !body.trim()}
        style={{
          marginTop: 8, padding: '7px 16px', borderRadius: 3, fontSize: 11,
          background: 'var(--accent-bg)', color: 'var(--accent-hover)',
          border: '1px solid var(--accent)',
          opacity: !body.trim() ? 0.4 : 1,
        }}>
        {posting ? 'POSTING...' : 'POST (Ctrl+Enter)'}
      </button>
    </div>
  )
}
