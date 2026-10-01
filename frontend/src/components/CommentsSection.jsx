import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { fetchComments, addComment, errorMessage } from '../api/client';
import { useQuery } from '../hooks/useQuery';
import { ErrorNote } from './ErrorNote';

export function CommentsSection({ wiId, refreshTick }) {
  const { data, error: loadError, reload } = useQuery(wiId, () => fetchComments(wiId), refreshTick);
  const comments = data ?? [];
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');

  const post = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setPosting(true);
    setError('');
    try {
      await addComment(wiId, text);
      setText('');
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not post the comment'));
    } finally { setPosting(false); }
  };

  return (
    <div>
      <div className="timeline-head">
        <h3>Timeline</h3>
        <span className="count-chip">{comments.length}</span>
      </div>
      {loadError && <ErrorNote>{errorMessage(loadError, 'Could not load comments')}</ErrorNote>}

      <div className="timeline">
        {comments.length > 0 && <div className="timeline-line" />}
        <div className="timeline-items">
          {comments.length === 0 && <p className="muted">No comments yet.</p>}
          {comments.map(c => (
            <div key={c.id} className="comment">
              <div className="comment-dot" />
              <div className="comment-card">
                <div className="comment-head">
                  <span className="comment-author">{c.author_username}</span>
                  <span className="comment-time">{formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}</span>
                </div>
                <p className="comment-body">{c.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <form className="composer" onSubmit={post}>
        <textarea
          name="comment"
          aria-label="Add a comment"
          placeholder="Add a comment… (Ctrl+Enter to post)"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) post(e); }}
        />
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="composer-actions">
          <button type="submit" className="btn btn-primary btn-pill" disabled={!text.trim() || posting}>
            {posting ? <span className="spinner" /> : 'Post'}
          </button>
        </div>
      </form>
    </div>
  );
}
