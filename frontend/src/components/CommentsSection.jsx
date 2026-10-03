import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { fetchComments, fetchHistory, addComment, errorMessage } from '../api/client';
import { useQuery } from '../hooks/useQuery';
import { useToast } from '../context/toast';
import { ErrorNote } from './ErrorNote';

// One line per history event, e.g. "alice changed status OPEN -> INVESTIGATING".
function eventText(e) {
  const who = e.actor_username ?? 'System';
  switch (e.kind) {
    case 'created': return `${who} opened the incident (${e.to_value})`;
    case 'status': return `${who} changed status ${e.from_value} -> ${e.to_value}`;
    case 'assigned': return e.to_value ? `${who} assigned to ${e.to_value}` : `${who} unassigned`;
    case 'rca_submitted': return `${who} submitted the RCA`;
    default: return `${who} ${e.kind}`;
  }
}

const ago = (iso) => formatDistanceToNow(new Date(iso), { addSuffix: true });

// Comments and history events, merged oldest first.
export function CommentsSection({ wiId, refreshTick }) {
  const comments = useQuery(wiId, () => fetchComments(wiId), refreshTick);
  const history = useQuery(wiId, () => fetchHistory(wiId), refreshTick);
  const toast = useToast();
  const entries = [
    ...(comments.data ?? []).map(c => ({ ...c, type: 'comment' })),
    ...(history.data ?? []).map(e => ({ ...e, type: 'event' })),
  ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const loadError = comments.error || history.error;
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  const post = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setPosting(true);
    try {
      await addComment(wiId, text);
      setText('');
      comments.reload();
      toast('Comment posted');
    } catch (err) {
      toast(errorMessage(err, 'Could not post the comment'), { kind: 'error' });
    } finally { setPosting(false); }
  };

  return (
    <div>
      <div className="timeline-head">
        <h3>Timeline</h3>
        <span className="count-chip">{entries.length}</span>
      </div>
      {loadError && <ErrorNote>{errorMessage(loadError, 'Could not load the timeline')}</ErrorNote>}

      <div className="timeline">
        {entries.length > 0 && <div className="timeline-line" />}
        <div className="timeline-items">
          {entries.length === 0 && <p className="muted">No comments yet.</p>}
          {entries.map(c => c.type === 'event' ? (
            <div key={`e:${c.id}`} className="comment timeline-event">
              <div className="comment-dot event-dot" />
              <div className="event-line">
                <span className="event-text">{eventText(c)}</span>
                <span className="comment-time">{ago(c.created_at)}</span>
              </div>
            </div>
          ) : (
            <div key={`c:${c.id}`} className="comment">
              <div className="comment-dot" />
              <div className="comment-card">
                <div className="comment-head">
                  <span className="comment-author">{c.author_username}</span>
                  <span className="comment-time">{ago(c.created_at)}</span>
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
        <div className="composer-actions">
          <button type="submit" className="btn btn-primary btn-pill" disabled={!text.trim() || posting}>
            {posting ? <span className="spinner" /> : 'Post'}
          </button>
        </div>
      </form>
    </div>
  );
}
