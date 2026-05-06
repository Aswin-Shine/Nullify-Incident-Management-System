import React, { useState, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { fetchComments, addComment } from '../api/client';

export function CommentsSection({ wiId }) {
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState('');
  const [posting, setPosting] = useState(false);

  const load = async () => {
    try {
      const data = await fetchComments(wiId);
      setComments(data);
    } catch (e) { console.error(e); }
  };

  useEffect(() => { load(); }, [wiId]);

  const handlePost = async () => {
    if (!newComment.trim()) return;
    setPosting(true);
    try {
      await addComment(wiId, newComment);
      setNewComment('');
      await load();
    } catch (e) { console.error(e); }
    finally { setPosting(false); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700 }}>Timeline</h3>
        <span style={{ fontSize: 11, background: 'var(--bg-raised)', padding: '2px 8px', borderRadius: 10, color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}>
          {comments.length}
        </span>
      </div>

      <div style={{ position: 'relative', paddingLeft: 24 }}>
        {comments.length > 0 && <div style={{ position: 'absolute', left: 7, top: 0, bottom: 0, width: 2, background: 'var(--border-subtle)' }} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {comments.length === 0 && <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No comments yet.</p>}
          {comments.map(c => (
            <div key={c.id} style={{ position: 'relative', animation: 'slideDown 0.2s' }}>
              <div style={{ position: 'absolute', left: -23, top: 4, width: 14, height: 14, borderRadius: '50%', background: 'var(--bg-overlay)', border: '2px solid var(--accent)' }} />
              <div style={{ background: 'var(--bg-raised)', padding: '12px 16px', borderRadius: '12px 12px 12px 4px', border: '1px solid var(--border-subtle)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
                  {/* FIX: backend returns author, not username */}
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{c.author || c.username || 'User'}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}</span>
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{c.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Input */}
      <div style={{ marginTop: 24, background: 'var(--bg-surface)', padding: 16, borderRadius: 16, border: '1px solid var(--border-default)' }}>
        <textarea
          placeholder="Add a comment… (Ctrl+Enter to post)"
          style={{ width: '100%', border: 'none', background: 'transparent', minHeight: 64, resize: 'none', boxShadow: 'none' }}
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handlePost(); }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={handlePost} disabled={!newComment.trim() || posting} className="btn btn-primary" style={{ padding: '6px 20px', borderRadius: 20, fontSize: 13 }}>
            {posting ? <span className="spinner" /> : 'Post'}
          </button>
        </div>
      </div>
    </div>
  );
}
